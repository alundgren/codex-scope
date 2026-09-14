import { test, expect } from "vite-plus/test";
import { mkdtemp, writeFile, readFile, stat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { connectionInput } from "../src/connection-input.ts";
import { loadPreferences, savePreferences, validateSettings } from "../src/preferences.ts";

test("pairing import keeps strict origins and rejects ambiguous or malformed secrets", () => {
  const saved = validateSettings(
    { endpoint: "https://host:443/?token=secret%2Bvalue", token: "", model: "gpt-5.6-luna" },
    null,
  );
  expect(saved).toEqual({ endpoint: "https://host", token: "secret+value", model: "gpt-5.6-luna" });
  for (const endpoint of [
    "https://host/path?token=a",
    "https://host/?token=a&token=b",
    "https://host/?other=a&token=b",
    "https://host/?token=%",
    "https://host/?token=",
    "https://host/?token=a#fragment",
    "https://user@host/?token=a",
    "http://host/?token=a",
    "https://host/../?token=a",
    "https://host/?token=a+b",
  ]) {
    expect(() => validateSettings({ endpoint, token: "", model: "gpt-5.6-luna" }, null)).toThrow();
  }
  expect(() => connectionInput("x".repeat(4097), "")).toThrow();
  expect(
    validateSettings({ endpoint: "http://127.0.0.1:8080", token: "", model: "gpt-5.6-luna" }, saved)
      .token,
  ).toBe(saved.token);
});

test("preferences are private atomic bounded writes and failed validation keeps bytes intact", async () => {
  const root = await mkdtemp("/tmp/scope-preferences-");
  const file = path.join(root, "preferences.json");
  try {
    expect(await loadPreferences(file)).toBeNull();
    const value = validateSettings(
      { endpoint: "https://host", token: "private-test-token", model: "gpt-5.6-luna" },
      null,
    );
    await savePreferences(file, value);
    const before = await readFile(file);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await loadPreferences(file)).toEqual(value);
    await writeFile(path.join(root, ".preferences.tmp"), "partial", { mode: 0o600 });
    await savePreferences(file, value);
    expect(await readdir(root)).toEqual(["preferences.json"]);
    await expect(savePreferences(file, { ...value, token: "x".repeat(5000) })).rejects.toThrow();
    expect(await readFile(file)).toEqual(before);
    expect(await readdir(root)).toEqual(["preferences.json"]);
    await writeFile(file, "x".repeat(4097));
    await expect(loadPreferences(file)).rejects.toThrow("Saved settings");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
