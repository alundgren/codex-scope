import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, lstat, open, opendir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { checkProcesses, CLI_RESOURCE_LIMITS } from "./cli-resources.ts";
import { REVIEW_LIMITS as L } from "./review-types.ts";
import type {
  ReviewPR,
  ReviewFile,
  ReviewRow,
  ReviewImage,
  ReviewReply,
  ReviewRequest,
} from "./review-types.ts";
const record = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const repo = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[\w.-]+\/[\w.-]+$/.test(v) &&
  v.length <= 200 &&
  !v.split("/").some((part) => part === "." || part === "..");
const oid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{40}$/.test(v);
const filePath = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= 1024 &&
  ![...v].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
  !v.startsWith("/") &&
  !v.split("/").some((x) => x === "." || x === "..");
const number = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
export function parsePR(input: string) {
  const match = input
    .trim()
    .match(/^(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+)(?:\/pull\/|\s+#?|#)([1-9]\d{0,8})\/?$/);
  if (!match || !repo(match[1]))
    throw new Error("Use a github.com PR URL or owner/repository #123.");
  return { repository: match[1], number: Number(match[2]) };
}
export function parsePatch(patch: string): ReviewRow[] {
  if (Buffer.byteLength(patch) > L.patchBytes)
    throw new Error("Patch exceeds the 128 KiB limit. Read either source side instead.");
  const rows: ReviewRow[] = [];
  let base = 0,
    head = 0,
    left = 0,
    right = 0,
    active = false;
  for (const line of patch.split("\n")) {
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      if (active && (left || right))
        throw new Error("Patch is incomplete. Read either source side instead.");
      base = Number(hunk[1]);
      head = Number(hunk[3]);
      left = Number(hunk[2] ?? 1);
      right = Number(hunk[4] ?? 1);
      if (
        ![base, head, left, right].every(
          (n) => Number.isSafeInteger(n) && n >= 0 && n <= 2147483647,
        ) ||
        (left > 0 && base === 0) ||
        (right > 0 && head === 0)
      )
        throw new Error("Patch has invalid line references.");
      active = true;
      rows.push({ base: null, head: null, text: line, kind: "header" });
    } else if (line.startsWith("\\ No newline")) continue;
    else if (active && (left || right)) {
      const prefix = line[0];
      if (![" ", "+", "-"].includes(prefix))
        throw new Error("Patch is incomplete. Read either source side instead.");
      const b = prefix !== "+" ? base++ : null,
        h = prefix !== "-" ? head++ : null;
      if (b !== null) left--;
      if (h !== null) right--;
      if (left < 0 || right < 0) throw new Error("Patch has invalid line references.");
      rows.push({
        base: b,
        head: h,
        text: line.slice(1),
        kind: prefix === "+" ? "add" : prefix === "-" ? "delete" : "context",
      });
    } else if (line !== "")
      throw new Error("Patch has unsupported content. Read either source side instead.");
    if (rows.length > L.maxLines) throw new Error("Patch exceeds the line limit.");
  }
  if (!active || left || right)
    throw new Error("Patch is incomplete. Read either source side instead.");
  return rows;
}
export function pngDimensions(bytes: Buffer) {
  if (
    bytes.length < 33 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new Error("Choose a PNG screenshot. Other formats are unsupported.");
  let position = 8,
    width = 0,
    height = 0,
    ended = false;
  while (position + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(position),
      type = bytes.toString("ascii", position + 4, position + 8);
    if (length > bytes.length - position - 12) throw new Error("The PNG is incomplete.");
    if (position === 8) {
      if (type !== "IHDR" || length !== 13) throw new Error("The PNG header is invalid.");
      width = bytes.readUInt32BE(position + 8);
      height = bytes.readUInt32BE(position + 12);
      if (!width || !height || width * height > L.imagePixels)
        throw new Error("Screenshot exceeds 4,194,304 decoded pixels.");
    } else if (type === "IHDR" || type === "acTL")
      throw new Error("Animated or invalid PNG screenshots are unsupported.");
    position += length + 12;
    if (type === "IEND") {
      ended = true;
      break;
    }
  }
  if (!ended || position !== bytes.length)
    throw new Error("The PNG is incomplete or has unsupported trailing data.");
  return { width, height };
}
async function readScreenshot(file: string): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > L.imageBytes)
      throw new Error("Screenshot exceeds 4 MiB or is not a regular file.");
    const buffer = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count !== stat.size)
      throw new Error("Screenshot changed while being read. Choose it again.");
    return buffer.subarray(0, count);
  } finally {
    await handle.close();
  }
}
export function runGh(
  args: string[],
  signal: AbortSignal,
  cwd: string,
  executable = "gh",
  limit: number = L.responseBytes,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("PR read cancelled."));
      return;
    }
    const child = spawn(executable, args, {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: "1",
        GH_PAGER: "cat",
        GH_DEBUG: "",
        GH_HOST: "github.com",
      },
    });
    let size = 0,
      diagnostics = 0,
      error: string | undefined,
      monitoring = false,
      closed = false;
    const chunks: Buffer[] = [];
    const kill = () => {
      if (child.pid)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Already exited. */
        }
    };
    const stop = (message: string) => {
      if (closed) return;
      error ??= message;
      kill();
    };
    const cancel = () => stop("PR read cancelled.");
    signal.addEventListener("abort", cancel, { once: true });
    const deadline = setTimeout(
      () => stop("GitHub read timed out. Retry when the connection is available."),
      L.commandMs,
    );
    const sampler = setInterval(() => {
      if (monitoring || !child.pid || error) return;
      monitoring = true;
      void checkProcesses(child.pid)
        .catch(() => stop("GitHub read exceeded its process limit or monitoring failed."))
        .finally(() => {
          monitoring = false;
        });
    }, CLI_RESOURCE_LIMITS.sampleMs);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) stop("GitHub response exceeds the read limit. This evidence is omitted.");
      else if (!error) chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostics += chunk.length;
      if (diagnostics > 32768) stop("GitHub diagnostics exceeded the limit.");
    });
    child.on("error", () => {
      error = "GitHub CLI is unavailable. Install gh and authenticate, then retry.";
    });
    child.on("close", (code) => {
      closed = true;
      clearTimeout(deadline);
      clearInterval(sampler);
      signal.removeEventListener("abort", cancel);
      kill();
      if (error) reject(new Error(error));
      else if (code !== 0)
        reject(
          new Error(
            "GitHub read failed. Check gh authentication, repository access and network, then retry.",
          ),
        );
      else resolve(Buffer.concat(chunks, size));
    });
  });
}
export class PRReview {
  private active: ReviewPR | null = null;
  private files: (ReviewFile & { patch?: string })[] = [];
  private selectedFile: (ReviewFile & { patch?: string }) | null = null;
  private loaded: { key: string; rows: ReviewRow[] } | null = null;
  private images: ReviewImage[] = [];
  private controller: AbortController | null = null;
  private pending: Promise<ReviewReply> | null = null;
  private initialized = false;
  readonly ready: Promise<void>;
  constructor(
    private directory: string,
    private picker: () => Promise<string | undefined>,
    private executable = "gh",
  ) {
    this.ready = this.storage();
  }
  cancel() {
    this.controller?.abort();
  }
  async close() {
    this.cancel();
    await this.pending;
    if (this.initialized) await this.clearImages();
  }
  private async storage() {
    if (this.initialized) return;
    await mkdir(this.directory, { mode: 0o700, recursive: true });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.uid !== process.getuid!() || stat.mode & 0o077)
      throw new Error("PR temporary storage is unavailable.");
    const entries: string[] = [];
    for await (const entry of await opendir(this.directory)) {
      if (entries.length >= L.images || !/^image-[a-f0-9-]+\.png$/.test(entry.name))
        throw new Error("PR temporary storage contains unexpected files.");
      entries.push(entry.name);
    }
    for (const name of entries) {
      const s = await lstat(path.join(this.directory, name));
      if (!s.isFile() || s.uid !== process.getuid!() || s.size > L.imageBytes)
        throw new Error("PR temporary storage contains unexpected files.");
      await rm(path.join(this.directory, name));
    }
    this.initialized = true;
  }
  private readingImage = false;
  acceptsImage(url: string): boolean {
    return (
      !!this.active &&
      this.images.some((image) => url === `scope://app/review-image/${this.active!.id}/${image.id}`)
    );
  }
  async readImage(url: string): Promise<Buffer | null> {
    if (this.readingImage || !this.acceptsImage(url)) return null;
    this.readingImage = true;
    try {
      const image = this.images.find((item) => url.endsWith(`/${item.id}`))!;
      const bytes = await readScreenshot(path.join(this.directory, `image-${image.id}.png`));
      const dimensions = pngDimensions(bytes);
      if (
        !this.acceptsImage(url) ||
        bytes.length !== image.bytes ||
        dimensions.width !== image.width ||
        dimensions.height !== image.height
      )
        return null;
      return bytes;
    } catch {
      return null;
    } finally {
      this.readingImage = false;
    }
  }
  private async clearImages() {
    for (const image of this.images)
      await rm(path.join(this.directory, `image-${image.id}.png`), { force: true });
    this.images = [];
  }
  async request(request: ReviewRequest): Promise<ReviewReply> {
    if (this.pending) return { error: "A PR operation is running. Cancel it or wait." };
    if (!record(request) || JSON.stringify(request).length > 4096)
      return { error: "Invalid PR request." };
    const controller = new AbortController();
    this.controller = controller;
    this.pending = this.perform(request, controller.signal).catch((error) => ({
      error: error instanceof Error ? error.message : "PR evidence is unavailable.",
    }));
    try {
      return await this.pending;
    } finally {
      this.pending = null;
      this.controller = null;
    }
  }
  private async api(endpoint: string, signal: AbortSignal, limit?: number, raw = false) {
    const bytes = await runGh(
      [
        "api",
        "--hostname",
        "github.com",
        endpoint,
        "-H",
        raw ? "Accept: application/vnd.github.raw+json" : "Accept: application/vnd.github+json",
      ],
      signal,
      this.directory,
      this.executable,
      limit,
    );
    if (signal.aborted) throw new Error("PR read cancelled.");
    if (raw) return bytes;
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("GitHub returned invalid or incomplete data.");
    }
  }
  private async metadata(
    target: { repository: string; number: number },
    signal: AbortSignal,
  ): Promise<ReviewPR> {
    const p = await this.api(`repos/${target.repository}/pulls/${target.number}`, signal);
    if (
      !record(p) ||
      !repo(p.base?.repo?.full_name) ||
      !(p.head?.repo === null || repo(p.head?.repo?.full_name)) ||
      !oid(p.base?.sha) ||
      !oid(p.head?.sha) ||
      typeof p.title !== "string" ||
      p.title.length > 1024 ||
      !(p.body === null || (typeof p.body === "string" && p.body.length <= 65536)) ||
      !number(p.changed_files) ||
      p.number !== target.number
    )
      throw new Error("GitHub PR metadata is invalid or exceeds its limit.");
    return {
      ...target,
      repository: p.base.repo.full_name,
      id: randomUUID(),
      title: p.title,
      body: p.body ?? "",
      state: String(p.state).slice(0, 20),
      base: p.base.sha,
      head: p.head.sha,
      baseRepository: p.base.repo.full_name,
      headRepository: p.head.repo?.full_name ?? null,
      fileCount: p.changed_files,
      diffBase: p.base.sha,
    };
  }
  private same(a: ReviewPR, b: ReviewPR) {
    return (
      a.repository === b.repository &&
      a.number === b.number &&
      a.base === b.base &&
      a.head === b.head &&
      a.headRepository === b.headRepository
    );
  }
  private async perform(r: ReviewRequest, signal: AbortSignal): Promise<ReviewReply> {
    await this.ready;
    if (r.action === "open") {
      if (typeof r.input !== "string" || r.input.length > 512)
        throw new Error("Invalid PR address.");
      if (this.active && r.replace !== true)
        throw new Error("Leave the current review before opening another PR.");
      const pr = await this.metadata(parsePR(r.input), signal);
      const comparison = await this.api(
        `repos/${pr.repository}/compare/${pr.base}...${pr.head}?per_page=1&page=2`,
        signal,
      );
      if (!oid(comparison?.merge_base_commit?.sha))
        throw new Error("GitHub comparison base is unavailable.");
      pr.diffBase = comparison.merge_base_commit.sha;
      await this.clearImages();
      this.active = pr;
      this.selectedFile = null;
      this.files = [];
      this.loaded = null;
      return { pr };
    }
    const pr = this.active;
    if (!pr || r.id !== pr.id) throw new Error("This PR review has ended. Open a PR to continue.");
    if (r.action === "end") {
      await this.clearImages();
      this.active = null;
      this.selectedFile = null;
      this.files = [];
      this.loaded = null;
      return {};
    }
    if (r.action === "refresh") return { changed: !this.same(pr, await this.metadata(pr, signal)) };
    if (r.action === "files") {
      if (
        !Number.isInteger(r.page) ||
        r.page < 1 ||
        r.page > Math.ceil(Math.min(pr.fileCount, L.maxFiles) / L.pageFiles)
      )
        throw new Error("That changed-file page is unavailable.");
      const raw = await this.api(
        `repos/${pr.repository}/pulls/${pr.number}/files?per_page=${L.pageFiles}&page=${r.page}`,
        signal,
      );
      if (
        !Array.isArray(raw) ||
        raw.length !== Math.min(L.pageFiles, pr.fileCount - (r.page - 1) * L.pageFiles)
      )
        throw new Error("GitHub changed-file response is invalid.");
      const files = raw.map((f: any) => {
        if (
          !record(f) ||
          !filePath(f.filename) ||
          !(f.previous_filename === undefined || filePath(f.previous_filename)) ||
          typeof f.status !== "string" ||
          !number(f.additions) ||
          !number(f.deletions)
        )
          throw new Error("GitHub changed-file data is invalid.");
        const patch =
          typeof f.patch === "string" && Buffer.byteLength(f.patch) <= L.patchBytes
            ? f.patch
            : undefined;
        return {
          path: f.filename,
          previousPath: f.previous_filename ?? null,
          status: f.status.slice(0, 32),
          additions: f.additions,
          deletions: f.deletions,
          patchAvailable: !!patch,
          omission: patch
            ? null
            : typeof f.patch === "string"
              ? "Patch exceeds 128 KiB. Read either source side."
              : "GitHub supplied no patch. The file may be binary, empty or too large.",
          patch,
        };
      });
      if (!this.same(pr, await this.metadata(pr, signal)))
        throw new Error(
          "The PR changed. Existing evidence stays pinned. Use Refresh PR to replace the review.",
        );
      this.files = files;
      return { files: files.map(({ patch: _patch, ...file }) => file), page: r.page };
    }
    if (r.action === "content") {
      const file =
        this.files.find((f) => f.path === r.path) ??
        (this.selectedFile?.path === r.path ? this.selectedFile : null);
      if (
        !file ||
        !["diff", "base", "head"].includes(r.mode) ||
        !Number.isInteger(r.offset) ||
        r.offset < 0 ||
        r.offset >= L.maxLines
      )
        throw new Error("Invalid source request.");
      this.selectedFile = file;
      const key = `${r.path}:${r.mode}`;
      if (this.loaded?.key !== key) {
        this.loaded = null;
        let rows: ReviewRow[];
        if (r.mode === "diff") {
          if (!file.patch)
            return {
              content: {
                path: r.path,
                previousPath: file.previousPath,
                mode: r.mode,
                rows: [],
                offset: 0,
                total: 0,
                omission: file.omission,
              },
            };
          rows = parsePatch(file.patch);
        } else {
          if (
            (r.mode === "head" && file.status === "removed") ||
            (r.mode === "base" && file.status === "added")
          )
            return {
              content: {
                path: r.path,
                previousPath: file.previousPath,
                mode: r.mode,
                rows: [],
                offset: 0,
                total: 0,
                omission: `File does not exist on the ${r.mode} side.`,
              },
            };
          const repository = r.mode === "base" ? pr.baseRepository : pr.headRepository;
          if (!repository)
            throw new Error(
              "The fork repository is unavailable. Supplied diff evidence remains readable.",
            );
          const name = r.mode === "base" ? (file.previousPath ?? file.path) : file.path;
          const bytes = (await this.api(
            `repos/${repository}/contents/${name.split("/").map(encodeURIComponent).join("/")}?ref=${r.mode === "base" ? pr.diffBase : pr.head}`,
            signal,
            L.sourceBytes,
            true,
          )) as Buffer;
          let text: string;
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            throw new Error("Binary or non-UTF-8 source is unsupported. No text was loaded.");
          }
          if (text.includes("\0"))
            throw new Error("Binary source is unsupported. No text was loaded.");
          const lines = text.split("\n");
          if (lines.length > L.maxLines)
            throw new Error("Source exceeds 20,000 lines. This evidence is omitted.");
          rows = lines.map((text, i) => ({
            base: r.mode === "base" ? i + 1 : null,
            head: r.mode === "head" ? i + 1 : null,
            text,
            kind: "context",
          }));
        }
        this.loaded = { key, rows };
      }
      return {
        content: {
          path: r.path,
          previousPath: file.previousPath,
          mode: r.mode,
          rows: this.loaded.rows.slice(r.offset, r.offset + L.rows),
          offset: r.offset,
          total: this.loaded.rows.length,
          omission: null,
        },
      };
    }
    if (r.action === "images") return { images: this.images };
    if (r.action === "attach") {
      if (this.images.length >= L.images)
        throw new Error("Four screenshots are already attached. Remove one to add another.");
      const selected = await this.picker();
      if (!selected) return { images: this.images };
      if (signal.aborted) throw new Error("Screenshot attachment cancelled.");
      const bytes = await readScreenshot(selected);
      const dimensions = pngDimensions(bytes);
      const id = randomUUID();
      const name = path.basename(selected).slice(0, 200);
      await writeFile(path.join(this.directory, `image-${id}.png`), bytes, {
        mode: 0o600,
        flag: "wx",
      });
      if (signal.aborted) {
        await rm(path.join(this.directory, `image-${id}.png`));
        throw new Error("Screenshot attachment cancelled.");
      }
      this.images.push({
        repository: pr.repository,
        number: pr.number,
        base: pr.base,
        head: pr.head,
        id,
        name,
        ...dimensions,
        bytes: bytes.length,
        attribution: `User supplied file: ${name}`,
      });
      return { images: this.images };
    }
    if (r.action === "image" || r.action === "remove-image") {
      const image = this.images.find((x) => x.id === r.image);
      if (!image) throw new Error("Screenshot is no longer available.");
      const file = path.join(this.directory, `image-${image.id}.png`);
      if (r.action === "remove-image") {
        await rm(file, { force: true });
        this.images = this.images.filter((x) => x !== image);
        return { images: this.images };
      }
      return { imageUrl: `scope://app/review-image/${pr.id}/${image.id}` };
    }
    throw new Error("Invalid PR operation.");
  }
}
