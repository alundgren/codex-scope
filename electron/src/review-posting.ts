import { mkdir, lstat, writeFile, rm, opendir } from "node:fs/promises";
import path from "node:path";
import { revisionText } from "./review-feedback.ts";
import { runGh, GhWriteError } from "./github-process.ts";
import type { ReviewPR } from "./review-types.ts";
import {
  POST_LIMITS as L,
  type PostingRequest,
  type PostingState,
  type PostedComment,
} from "./review-posting-types.ts";

export class ReviewPosting {
  private state: PostingState = {
    status: "idle",
    body: "",
    message: "",
    comment: null,
    candidates: [],
    checked: false,
  };
  private review = "";
  private user = 0;
  private since = "";
  private controller: AbortController | null = null;
  private pending: Promise<PostingState> | null = null;
  private closed = false;
  private cleanupFailed = false;
  private ownedBody = false;
  private ready: Promise<void>;
  constructor(
    private directory: string,
    private identity: (id: string) => ReviewPR,
    private preflight: (id: string, signal: AbortSignal) => Promise<boolean>,
    private executable = "gh",
  ) {
    this.ready = this.storage();
    void this.ready.catch(() => {});
  }
  private async storage() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.uid !== process.getuid!() || stat.mode & 0o077)
      throw Error("Private comment storage is unavailable.");
    const entries: string[] = [];
    for await (const entry of await opendir(this.directory)) {
      if (entries.length >= 1) throw Error("Unexpected comment storage contents.");
      entries.push(entry.name);
    }
    if (entries.length > 1 || entries.some((name) => name !== "body.md"))
      throw Error("Unexpected comment storage contents.");
    if (entries.length) {
      const file = path.join(this.directory, "body.md"),
        body = await lstat(file);
      if (
        !body.isFile() ||
        body.uid !== process.getuid!() ||
        body.mode & 0o077 ||
        body.size > L.bodyBytes
      )
        throw Error("Unrecognized comment body file.");
      this.ownedBody = true;
      await rm(file);
      this.ownedBody = false;
    }
  }
  reset() {
    if (this.blocksSwitch) throw Error("Resolve the pending comment before changing review.");
    this.review = "";
    this.state = {
      status: "idle",
      body: "",
      message: "",
      comment: null,
      candidates: [],
      checked: false,
    };
    this.user = 0;
    this.since = "";
  }
  link(id: string, comment: number | null): string {
    const pr = this.current(id);
    if (comment === null) return `https://github.com/${pr.repository}/pull/${pr.number}`;
    if (id !== this.review) throw Error("Comment belongs to another review.");
    const known = [this.state.comment, ...this.state.candidates].find((c) => c?.id === comment);
    if (!known) throw Error("Unknown comment link.");
    return known.url;
  }
  get blocksSwitch() {
    return !!this.pending || this.state.status === "uncertain";
  }
  async close() {
    this.closed = true;
    this.controller?.abort();
    await this.pending;
    await this.ready.catch(() => {});
    if (this.ownedBody) {
      await rm(path.join(this.directory, "body.md"), { force: true });
      this.ownedBody = false;
    }
  }
  private async api(endpoint: string, signal: AbortSignal, extra: string[] = [], writing = false) {
    const bytes = await runGh(
      ["api", "--hostname", "github.com", endpoint, ...extra],
      signal,
      this.directory,
      this.executable,
      2 * 1024 * 1024,
      writing,
    );
    return JSON.parse(bytes.toString("utf8"));
  }
  private comment(value: any, pr: ReviewPR): PostedComment | null {
    if (
      !Number.isSafeInteger(value?.id) ||
      value.id < 1 ||
      value.body !== this.state.body ||
      value.user?.id !== this.user ||
      typeof value.created_at !== "string" ||
      !Number.isFinite(Date.parse(value.created_at)) ||
      value.created_at < this.since ||
      value.html_url !==
        `https://github.com/${pr.repository}/pull/${pr.number}#issuecomment-${value.id}`
    )
      return null;
    return { id: value.id, url: value.html_url, created: value.created_at };
  }
  private current(id: string) {
    if (this.closed) throw Error("Posting has ended.");
    return this.identity(id);
  }
  request(request: PostingRequest): Promise<PostingState> {
    if (this.pending)
      return Promise.reject(Error("A comment operation is pending. Wait for its result."));
    if (
      !request ||
      typeof request.review !== "string" ||
      JSON.stringify(request).length > L.bodyBytes * 6 + 1024
    )
      return Promise.reject(Error("Invalid comment request."));
    this.current(request.review);
    if (this.review !== request.review) {
      if (this.state.status === "uncertain")
        return Promise.reject(Error("Resolve the previous comment before changing review."));
      this.review = request.review;
      this.state = {
        status: "idle",
        body: "",
        message: "",
        comment: null,
        candidates: [],
        checked: false,
      };
    }
    this.controller = new AbortController();
    this.pending = this.perform(request, this.controller.signal).finally(() => {
      this.pending = null;
      this.controller = null;
    });
    return this.pending;
  }
  private async perform(r: PostingRequest, signal: AbortSignal): Promise<PostingState> {
    const pr = this.current(r.review);
    if (r.action === "read") return structuredClone(this.state);
    if (r.action === "resolve") {
      if (this.state.status !== "uncertain" || !this.state.checked)
        throw Error("Check GitHub for this comment before resolving delivery.");
      if (r.candidate === null) {
        this.state.status = "failed";
        this.state.message =
          "You confirmed the comment is absent. Another explicit posting action is available.";
      } else {
        const found = this.state.candidates.find((c) => c.id === r.candidate);
        if (!found) throw Error("Choose one of the verified candidate comments.");
        this.state.status = "sent";
        this.state.comment = found;
        this.state.message = "You selected the matching GitHub comment. Sent body is shown below.";
      }
      return structuredClone(this.state);
    }
    await this.ready;
    const stat = await lstat(this.directory);
    if (
      !stat.isDirectory() ||
      stat.uid !== process.getuid!() ||
      stat.mode & 0o077 ||
      this.cleanupFailed
    )
      throw Error("Private comment storage is unavailable. Restart Scope before posting.");
    if (r.action === "verify") {
      if (this.state.status !== "uncertain")
        throw Error("There is no uncertain comment to verify.");
      this.state.candidates = [];
      this.state.checked = false;
      try {
        for (let page = 1; page <= L.pages; page++) {
          const comments = await this.api(
            `repos/${pr.repository}/issues/${pr.number}/comments?since=${encodeURIComponent(this.since)}&per_page=${L.pageSize}&page=${page}`,
            signal,
          );
          this.current(r.review);
          if (!Array.isArray(comments) || comments.length > L.pageSize)
            throw Error("Invalid comment page.");
          for (const value of comments) {
            const candidate = this.comment(value, pr);
            if (candidate && !this.state.candidates.some((c) => c.id === candidate.id)) {
              if (this.state.candidates.length >= L.candidates)
                throw Error("Candidate limit reached.");
              this.state.candidates.push(candidate);
            }
          }
          if (comments.length < L.pageSize) {
            this.state.checked = true;
            break;
          }
        }
        if (this.state.checked && this.state.candidates.length === 1) {
          this.state.status = "sent";
          this.state.comment = this.state.candidates[0]!;
          this.state.message = "Exact body, posting account and attempt time verified on GitHub.";
        } else {
          this.state.checked = true;
          this.state.message =
            "Delivery remains unresolved. Inspect the PR and matching candidates before choosing a resolution. Only the first 60 recent comments were checked.";
        }
      } catch {
        this.state.checked = true;
        this.state.message =
          "GitHub verification was incomplete. Inspect the PR yourself before resolving delivery. No comment was sent by this check.";
      }
      return structuredClone(this.state);
    }
    if (r.action !== "post") throw Error("Invalid comment action.");
    if (this.state.status === "uncertain")
      throw Error("Resolve uncertain delivery before another write.");
    if (this.state.status === "sent" && r.body === this.state.body)
      throw Error("This exact body has already been sent.");
    if (
      typeof r.body !== "string" ||
      Buffer.byteLength(r.body) > L.bodyBytes ||
      !r.body.endsWith(`\n\nFeedback revision\n${revisionText(pr)}`) ||
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(r.body) ||
      r.body.includes("\r") ||
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(r.body)) !== r.body
    )
      throw Error(
        "Comment must be valid text of at most 65,536 UTF-8 bytes, with the unchanged feedback revision and LF line endings.",
      );
    this.state = {
      status: "failed",
      body: r.body,
      message: "",
      comment: null,
      candidates: [],
      checked: false,
    };
    let file = false;
    let writeStarted = false;
    try {
      for await (const _entry of await opendir(this.directory)) {
        throw Error("Private comment storage is not empty.");
      }
      const account = await this.api("user", signal);
      if (!Number.isSafeInteger(account?.id) || account.id < 1)
        throw Error("GitHub account identity is unavailable.");
      this.user = account.id;
      if (!(await this.preflight(r.review, signal))) {
        this.state.status = "stale";
        this.state.message =
          "PR identity or revision changed. Keep or copy this draft, then refresh and review the new revision.";
        return structuredClone(this.state);
      }
      this.current(r.review);
      await writeFile(path.join(this.directory, "body.md"), r.body, { mode: 0o600, flag: "wx" });
      file = true;
      this.ownedBody = true;
      this.current(r.review);
      if (signal.aborted) throw Error("Posting cancelled before delivery.");
      this.since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      writeStarted = true;
      const output = await runGh(
        [
          "pr",
          "comment",
          String(pr.number),
          "--repo",
          pr.repository,
          "--body-file",
          path.join(this.directory, "body.md"),
        ],
        signal,
        this.directory,
        this.executable,
        2048,
        true,
      );
      const url = output.toString("utf8").trim();
      const prefix = `https://github.com/${pr.repository}/pull/${pr.number}#issuecomment-`;
      if (!url.startsWith(prefix) || !/^[1-9][0-9]{0,15}$/.test(url.slice(prefix.length)))
        throw Error("Unverified comment URL.");
      const result = await this.api(
        `repos/${pr.repository}/issues/comments/${url.slice(prefix.length)}`,
        signal,
      );
      this.current(r.review);
      const comment = this.comment(result, pr);
      if (!comment) throw Error("Comment response could not be verified.");
      this.state.status = "sent";
      this.state.comment = comment;
      this.state.message = "Comment posted. The exact sent body is shown below.";
    } catch (error) {
      this.state.status =
        writeStarted && !(error instanceof GhWriteError && error.definitive)
          ? "uncertain"
          : "failed";
      this.state.message =
        this.state.status === "uncertain"
          ? "Delivery is uncertain. Do not retry until you check GitHub and resolve whether this comment exists."
          : "No comment was sent. Check gh availability, authentication, access and network, then explicitly retry.";
    } finally {
      if (file)
        try {
          await rm(path.join(this.directory, "body.md"));
          this.ownedBody = false;
        } catch {
          this.cleanupFailed = true;
          this.state.message += " Private body cleanup failed. Restart Scope before posting again.";
        }
    }
    return structuredClone(this.state);
  }
}
