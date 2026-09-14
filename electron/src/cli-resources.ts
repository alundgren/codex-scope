import { execFile } from "node:child_process";
import { mkdir, open, writeFile, rm, opendir, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const CLI_RESOURCE_LIMITS = {
  sampleMs: 500,
  processRssBytes: 512 * 1024 * 1024,
  processCount: 8,
  processCpuSeconds: 30,
  tempBytes: 16 * 1024 * 1024,
  tempEntries: 64,
} as const;
function processSeconds(value: string): number {
  const [days, rest] = value.includes("-") ? value.split("-") : ["0", value];
  return (
    Number(days) * 86_400 + rest.split(":").reduce((total, part) => total * 60 + Number(part), 0)
  );
}

/** Sample only process identifiers and resource totals, never command lines or environment. */
export async function checkProcesses(group: number): Promise<void> {
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      "/bin/ps",
      ["-axo", "pgid=,rss=,time="],
      { timeout: 1000, maxBuffer: 512 * 1024, encoding: "utf8" },
      (error, stdout) =>
        error ? reject(new Error("Could not monitor Codex process resources.")) : resolve(stdout),
    );
  });
  let count = 0,
    rss = 0,
    cpu = 0;
  for (const line of output.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (Number(fields[0]) !== group) continue;
    count++;
    rss += Number(fields[1]) * 1024;
    cpu += processSeconds(fields[2]);
  }
  if (
    !Number.isFinite(rss) ||
    !Number.isFinite(cpu) ||
    count > CLI_RESOURCE_LIMITS.processCount ||
    rss > CLI_RESOURCE_LIMITS.processRssBytes ||
    cpu > CLI_RESOURCE_LIMITS.processCpuSeconds
  )
    throw new Error("Codex analysis exceeded its process resource limit.");
}

export async function checkTemp(directory: string): Promise<void> {
  let entries = 0,
    bytes = 0;
  const pending = [directory];
  while (pending.length) {
    const dir = await opendir(pending.pop()!);
    for await (const entry of dir) {
      if (++entries > CLI_RESOURCE_LIMITS.tempEntries)
        throw new Error("Codex analysis exceeded its temporary storage limit.");
      const file = path.join(dir.path, entry.name);
      const stat = await lstat(file);
      if (stat.uid !== process.getuid!() || (!stat.isFile() && !stat.isDirectory()))
        throw new Error("Analysis temporary storage contains an unexpected entry.");
      bytes += stat.size;
      if (bytes > CLI_RESOURCE_LIMITS.tempBytes)
        throw new Error("Codex analysis exceeded its temporary storage limit.");
      if (stat.isDirectory()) pending.push(file);
    }
  }
}

const storageFailureMessage =
  "Analysis temporary storage could not be safely reused. Close any earlier analysis process before removing the app's analysis temporary files.";
const activeOwnerMessage =
  "An earlier analysis process may still be running. Wait for it to stop before analyzing again.";

async function privateDirectory(directory: string): Promise<void> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0)
    throw new Error(storageFailureMessage);
}

export async function prepareDirectory(root: string): Promise<string> {
  try {
    if (!path.isAbsolute(root) || path.dirname(root) === root)
      throw new Error(storageFailureMessage);
    await mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    await privateDirectory(root);
    const directory = path.join(root, "work");
    const marker = path.join(root, "owner.json");
    const entries = new Set<string>();
    for await (const entry of await opendir(root)) {
      if (!["work", "owner.json"].includes(entry.name) || entries.size >= 2)
        throw new Error(storageFailureMessage);
      entries.add(entry.name);
    }
    if (entries.has("work")) await privateDirectory(directory);
    if (entries.has("owner.json")) {
      const handle = await open(marker, constants.O_RDONLY | constants.O_NOFOLLOW);
      let owner: unknown;
      try {
        const stat = await handle.stat();
        if (
          !stat.isFile() ||
          stat.uid !== process.getuid!() ||
          stat.size > 128 ||
          (stat.mode & 0o077) !== 0
        )
          throw new Error(storageFailureMessage);
        const buffer = Buffer.alloc(128);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        owner = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      } finally {
        await handle.close();
      }
      if (
        !record(owner) ||
        Object.keys(owner).length !== 1 ||
        !Number.isSafeInteger(owner.group) ||
        Number(owner.group) < 1 ||
        Number(owner.group) > 2_147_483_647
      )
        throw new Error(storageFailureMessage);
      try {
        process.kill(-Number(owner.group), 0);
        throw new Error(activeOwnerMessage);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new Error(activeOwnerMessage);
      }
      if (entries.has("work")) {
        await checkTemp(directory);
        await removePrivateDirectory(directory);
      }
      await rm(marker);
    } else if (entries.has("work")) {
      // An interrupted marker write cannot establish whether a CLI still owns these files.
      throw new Error(storageFailureMessage);
    }
    await mkdir(directory, { mode: 0o700 });
    // A crash before the child group is recorded leaves one blocked work directory.
    await writeFile(marker, JSON.stringify({ group: 0 }), { mode: 0o600, flag: "wx" });
    return directory;
  } catch (error) {
    if (cleanupFailed) throw new Error(cleanupFailureMessage);
    if (error instanceof Error && error.message === activeOwnerMessage) throw error;
    throw new Error(storageFailureMessage);
  }
}

export async function removePrivateDirectory(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true });
  } catch {
    cleanupFailed = true;
    throw new Error(cleanupFailureMessage);
  }
}

export let cleanupFailed = false;
export const cleanupFailureMessage =
  "Analysis temporary files could not be removed. Remove the app's analysis temporary files and restart Codex Scope before analyzing again.";
