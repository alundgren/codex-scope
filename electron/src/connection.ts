import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";
import { isIP } from "node:net";
function origin(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    !/^https?:\/\/(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(?::[0-9]+)?\/?$/.test(value)
  )
    throw new Error("config");
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("config");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && (host === "::1" || (isIP(host) === 4 && host.startsWith("127."))))
  )
    throw new Error("config");
  return url.origin;
}
async function privateText(file: string, maximum: number) {
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size > maximum ||
      stat.mode & 0o077 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("config");
    const buffer = Buffer.alloc(maximum + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maximum || bytesRead !== stat.size) throw new Error("config");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}
async function loadConnection(file: string, optional = false) {
  let raw;
  try {
    raw = await privateText(file, 4096);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("config");
  }
  try {
    const config = JSON.parse(raw);
    if (
      !config ||
      typeof config !== "object" ||
      Object.keys(config).some((key) => !["endpoint", "tokenFile"].includes(key)) ||
      typeof config.tokenFile !== "string" ||
      config.tokenFile.length > 2048 ||
      !path.isAbsolute(config.tokenFile)
    )
      throw new Error("config");
    const endpoint = origin(config.endpoint);
    const token = (await privateText(config.tokenFile, 257)).replace(/\r?\n$/, "");
    if (!/^[A-Za-z0-9._~+/-]{1,256}={0,2}$/.test(token) || token.length > 256)
      throw new Error("config");
    return { endpoint, token };
  } catch {
    throw new Error("config");
  }
}
export { origin, loadConnection };
