import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  checkProcesses,
  checkTemp,
  prepareDirectory,
  removePrivateDirectory,
  CLI_RESOURCE_LIMITS,
} from "./cli-resources.ts";
import { validModel, validEffort, type CatalogModel, type ModelCatalog } from "./model-types.ts";
export const CATALOG_LIMITS = {
  durationMs: 5000,
  stdoutBytes: 512 * 1024,
  stderrBytes: 32 * 1024,
  pages: 16,
  models: 256,
  pageSize: 32,
  efforts: 32,
  cursorBytes: 1024,
} as const;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const incomplete = "The model catalog is incomplete. Refresh models to try again.";
export class CatalogDiscovery {
  private pending: Promise<ModelCatalog> | null = null;
  private abort: AbortController | null = null;
  constructor(
    private root: string,
    private executable = "codex",
  ) {}
  get busy() {
    return this.pending !== null;
  }
  cancel() {
    this.abort?.abort();
  }
  async close() {
    this.cancel();
    await this.pending;
  }
  async read(signal?: AbortSignal): Promise<ModelCatalog> {
    if (this.pending)
      return {
        models: [],
        complete: false,
        error: "Model discovery is still stopping or running. Try again.",
      };
    const controller = new AbortController();
    this.abort = controller;
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    this.pending = this.discover(controller.signal).catch(() => ({
      models: [],
      complete: false,
      error:
        "Model discovery failed. Check the local CLI and private temporary directory, then retry.",
    }));
    try {
      return await this.pending;
    } finally {
      signal?.removeEventListener("abort", cancel);
      this.pending = null;
      this.abort = null;
    }
  }
  private async discover(signal: AbortSignal): Promise<ModelCatalog> {
    if (signal.aborted)
      return {
        models: [],
        complete: false,
        error: "Model discovery cancelled. Refresh models to try again.",
      };
    const directory = await prepareDirectory(this.root);
    try {
      return await this.execute(directory, signal);
    } finally {
      await removePrivateDirectory(directory);
      await removePrivateDirectory(path.join(this.root, "owner.json"));
    }
  }
  private execute(directory: string, signal: AbortSignal): Promise<ModelCatalog> {
    return new Promise((resolve) => {
      const child = spawn(
        "/bin/sh",
        [
          "-c",
          'ulimit -c 0 && ulimit -t 30 && exec "$@"',
          "catalog-cli",
          this.executable,
          "app-server",
          "-c",
          `log_dir=${JSON.stringify(directory)}`,
          "-c",
          'history.persistence="none"',
          "-c",
          "analytics.enabled=false",
          "-c",
          'otel.exporter="none"',
          "-c",
          'otel.trace_exporter="none"',
          "-c",
          'otel.metrics_exporter="none"',
          "-c",
          "otel.log_user_prompt=false",
        ],
        {
          cwd: directory,
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            RUST_LOG: "off",
            TMPDIR: directory,
            TMP: directory,
            TEMP: directory,
          },
        },
      );
      let bytes = 0,
        diagnostics = 0,
        pages = 0,
        expected = 1,
        complete = false,
        error: string | undefined;
      let partial = Buffer.alloc(0);
      const models: CatalogModel[] = [],
        cursors = new Set<string>(),
        ids = new Set<string>(),
        names = new Set<string>();
      let monitoring: Promise<void> | undefined;
      const kill = () => {
        if (child.pid)
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* Already exited. */
          }
      };
      const stop = (message: string) => {
        error ??= message;
        kill();
      };
      const cancel = () => stop("Model discovery cancelled. Refresh models to try again.");
      const deadline = setTimeout(
        () => stop("Model discovery timed out. The catalog is incomplete; refresh to retry."),
        CATALOG_LIMITS.durationMs,
      );
      const sample = setInterval(() => {
        if (monitoring || !child.pid || error || complete) return;
        monitoring = Promise.all([checkProcesses(child.pid), checkTemp(directory)])
          .then(
            () => {},
            () =>
              stop(
                "Model discovery exceeded its resource limit or monitoring failed. Refresh to retry.",
              ),
          )
          .finally(() => {
            monitoring = undefined;
          });
      }, CLI_RESOURCE_LIMITS.sampleMs);
      const send = (method: string, params: unknown, id?: number) =>
        child.stdin.write(
          JSON.stringify({ method, params, ...(id === undefined ? {} : { id }) }) + "\n",
        );
      const list = (cursor: string | null) =>
        send(
          "model/list",
          { includeHidden: true, limit: CATALOG_LIMITS.pageSize, cursor },
          ++expected,
        );
      const accept = (line: Buffer) => {
        if (error || complete) return;
        try {
          const value: unknown = JSON.parse(line.toString("utf8"));
          if (!record(value)) throw new Error();
          if (value.id === undefined && typeof value.method === "string") return;
          if (value.id !== expected || !record(value.result)) {
            if (record(value.error)) {
              stop(
                "Codex could not list models. Check local CLI authentication and protocol support, then refresh.",
              );
              return;
            }
            throw new Error();
          }
          if (expected === 1) {
            send("initialized", {});
            list(null);
            return;
          }
          const { data, nextCursor } = value.result;
          if (!Array.isArray(data) || models.length + data.length > CATALOG_LIMITS.models)
            throw new Error();
          for (const entry of data) {
            if (
              !record(entry) ||
              !validModel(entry.id) ||
              !validModel(entry.model) ||
              typeof entry.hidden !== "boolean" ||
              !Array.isArray(entry.supportedReasoningEfforts) ||
              entry.supportedReasoningEfforts.length > CATALOG_LIMITS.efforts ||
              ids.has(entry.id) ||
              names.has(entry.model)
            )
              throw new Error();
            const efforts: string[] = [];
            for (const option of entry.supportedReasoningEfforts) {
              if (
                !record(option) ||
                !validEffort(option.reasoningEffort) ||
                efforts.includes(option.reasoningEffort)
              )
                throw new Error();
              efforts.push(option.reasoningEffort);
            }
            ids.add(entry.id);
            names.add(entry.model);
            models.push({ id: entry.id, model: entry.model, hidden: entry.hidden, efforts });
          }
          pages++;
          if (nextCursor === null || nextCursor === undefined) {
            complete = true;
            kill();
            return;
          }
          if (
            typeof nextCursor !== "string" ||
            !nextCursor ||
            Buffer.byteLength(nextCursor) > CATALOG_LIMITS.cursorBytes ||
            cursors.has(nextCursor) ||
            pages >= CATALOG_LIMITS.pages
          )
            throw new Error();
          cursors.add(nextCursor);
          list(nextCursor);
        } catch {
          stop(incomplete);
        }
      };
      child.stdout.on("data", (chunk: Buffer) => {
        if (error || complete) return;
        bytes += chunk.length;
        if (bytes > CATALOG_LIMITS.stdoutBytes) {
          stop(
            "Model discovery exceeded its output limit. The catalog is incomplete; refresh to retry.",
          );
          return;
        }
        partial = Buffer.concat([partial, chunk]);
        let newline: number;
        while ((newline = partial.indexOf(10)) >= 0) {
          accept(partial.subarray(0, newline));
          partial = partial.subarray(newline + 1);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        diagnostics += chunk.length;
        if (diagnostics > CATALOG_LIMITS.stderrBytes)
          stop("Model discovery exceeded its diagnostic output limit. Refresh to retry.");
      });
      child.stdin.on("error", () => {});
      child.on("error", () =>
        stop("Could not start the local Codex CLI. Install Codex and make it available on PATH."),
      );
      child.on("exit", kill);
      const ownership = child.pid
        ? writeFile(path.join(this.root, "owner.json"), JSON.stringify({ group: child.pid }), {
            mode: 0o600,
          }).catch(() => stop("Model discovery could not record process ownership."))
        : Promise.resolve();
      child.on("close", (code) => {
        clearTimeout(deadline);
        clearInterval(sample);
        signal.removeEventListener("abort", cancel);
        kill();
        void (async () => {
          await ownership;
          await monitoring;
          try {
            await checkTemp(directory);
          } catch {
            error = "Model discovery exceeded its temporary storage limit.";
          }
          if (code === 127)
            error =
              "The local Codex CLI was not found. Install Codex and make it available on PATH, then refresh.";
          resolve({
            models,
            complete: complete && !error,
            ...(error || !complete
              ? { error: error ?? incomplete }
              : models.length
                ? {}
                : {
                    error:
                      "The local CLI returned no models. Check authentication and refresh to retry.",
                  }),
          });
        })();
      });
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      else send("initialize", { clientInfo: { name: "codex_scope", version: "0.1.0" } }, expected);
    });
  }
}
