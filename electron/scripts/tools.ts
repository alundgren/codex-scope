import { createRequire } from "node:module";
import path from "node:path";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
export const electronDirectory = path.join(
  path.dirname(require.resolve("electron/package.json")),
  "dist",
);
export const playwrightCli = require.resolve("@playwright/test/cli");
export const vpCli = path.join(
  path.dirname(require.resolve("vite-plus/package.json")),
  "bin",
  "vp",
);
export function dependencyVersions(): Record<string, string> {
  return Object.fromEntries(
    ["electron", "@playwright/test", "vite-plus"].map((name) => {
      const metadata = JSON.parse(
        readFileSync(require.resolve(`${name}/package.json`), "utf8"),
      ) as { version: string };
      return [name, metadata.version];
    }),
  );
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
