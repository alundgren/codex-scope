import { execFileSync } from "node:child_process";

const files = execFileSync(
  "git",
  [
    "ls-files",
    "--cached",
    "--full-name",
    "-z",
    "--",
    ":/.artifacts",
    ":/docs/evidence",
    ":/docs/validation",
    ":/electron/measurements",
  ],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);

if (files.length) {
  process.stderr.write(
    "Generated evidence belongs only in GitHub PR attachments. Remove these paths from the Git index:\n",
  );
  for (const file of files) process.stderr.write(`${JSON.stringify(file)}\n`);
  process.exitCode = 1;
}
