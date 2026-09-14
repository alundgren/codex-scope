import * as fs from "node:fs/promises";
import path from "node:path";
import { privateText, origin } from "./connection.ts";
import { connectionInput, validToken } from "./connection-input.ts";
import type { ConnectionConfig, SettingsEdit } from "./types.ts";

export const defaultModel = "gpt-5.6-luna";
export function validateSettings(value: SettingsEdit, previous: ConnectionConfig | null) {
  const parsed = connectionInput(value.endpoint, value.token);
  const token = parsed.token || previous?.token;
  if (!validToken(token) || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(value.model))
    throw new Error("Check the token and diagnosis model.");
  return { endpoint: origin(parsed.endpoint), token, model: value.model };
}
export async function loadPreferences(file: string) {
  try {
    const value = JSON.parse(await privateText(file, 4096));
    if (Object.keys(value).length !== 3) throw new Error("preferences");
    return validateSettings(value, null);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Saved settings could not be read. Enter the connection again and save.");
  }
}
export async function savePreferences(file: string, value: SettingsEdit) {
  const text = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(text) > 4096) throw new Error("Settings are too long.");
  const parent = path.dirname(file);
  const stat = await fs.lstat(parent);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid()))
    throw new Error("Settings directory is unavailable.");
  const temporary = path.join(parent, ".preferences.tmp");
  try {
    await privateText(temporary, 4096);
    await fs.rm(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let committed = false;
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(text);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, file);
    committed = true;
  } finally {
    await handle?.close();
    if (!committed) await fs.rm(temporary, { force: true });
  }
}
