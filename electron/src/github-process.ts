import { spawn } from "node:child_process";
import { checkProcesses, CLI_RESOURCE_LIMITS } from "./cli-resources.ts";
import { REVIEW_LIMITS as L } from "./review-types.ts";
export class GhWriteError extends Error {
  constructor(public definitive: boolean) {
    super("GitHub comment delivery failed.");
  }
}
export function runGh(
  args: string[],
  signal: AbortSignal,
  cwd: string,
  executable = "gh",
  limit: number = L.responseBytes,
  writing = false,
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
    let spawnFailed = false;
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
      spawnFailed = true;
      error = "GitHub CLI is unavailable. Install gh and authenticate, then retry.";
    });
    child.on("close", (code) => {
      closed = true;
      clearTimeout(deadline);
      clearInterval(sampler);
      signal.removeEventListener("abort", cancel);
      kill();
      if (writing && (error || code !== 0)) reject(new GhWriteError(spawnFailed));
      else if (error) reject(new Error(error));
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
