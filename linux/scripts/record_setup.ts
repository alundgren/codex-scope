/** Record the actual native CLI in a PTY using private synthetic host fixtures.
 * Development only: node linux/scripts/record_setup.ts [artifact-directory].
 * systemd/Codex approval metadata and Tailscale are simulated. The collector,
 * observer, prompts, configuration writes, and recovery commands are real.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deepStrictEqual } from "node:assert";
import { createHash } from "node:crypto";

const linux = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profile = existsSync(join(linux, "target/release/codex-scope")) ? "release" : "debug";
const binary = join(linux, `target/${profile}/codex-scope`);
const observer = join(linux, `target/${profile}/codex-scope-observer`);
const output = resolve(process.argv[2] ?? join(linux, "../.artifacts/visual/native-setup"));
if (!existsSync(binary) || !existsSync(observer))
  throw new Error(
    "Build native binaries first with cargo build --manifest-path linux/Cargo.toml --release --bins",
  );
const binaryHash = createHash("sha256").update(readFileSync(binary)).digest("hex");
mkdirSync(output, { recursive: true });
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
const fixtureCommand = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const home = process.env.HOME, action = path.basename(process.argv[1]), args = process.argv.slice(2);
const recordPath = path.join(home, '.local/state/codex-scope-installer/installation.json');
const unit = path.join(home, '.config/systemd/user/codex-scope.service');
const pidFile = path.join(home, '.fixture-service.pid');
const stateFile = path.join(home, '.fixture-state');
function stop() {
  if (fs.existsSync(pidFile)) { try { process.kill(Number(fs.readFileSync(pidFile)), 'SIGTERM'); } catch {} }
  fs.writeFileSync(stateFile, 'inactive');
}
if (action === 'loginctl') { console.log(process.env.SCOPE_FIXTURE_SCENARIO === 'failure' ? 'no' : 'yes'); }
else if (action === 'systemctl') {
  if (args.includes('--property=LoadState')) console.log(fs.existsSync(unit) ? 'loaded' : 'not-found');
  else if (args.includes('--property=FragmentPath')) console.log(fs.existsSync(unit) ? unit : '');
  else if (args.includes('--property=DropInPaths')) console.log('');
  else if (args.includes('--property=ActiveState')) console.log(fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : 'inactive');
  else if (args.includes('enable') || args.includes('start')) {
    const r = JSON.parse(fs.readFileSync(recordPath));
    const p = cp.spawn(path.join(r.app, 'codex-scope'), ['collector', '--runtime-dir', r.runtime, '--token-file', path.join(r.data, 'viewer.token'), '--port', String(r.port)], { detached: true, stdio: 'ignore' });
    fs.writeFileSync(pidFile, String(p.pid)); fs.writeFileSync(stateFile, 'active'); p.unref();
  } else if (args.includes('stop') || args.includes('disable')) stop();
}
else if (action === 'tailscale') { console.log(JSON.stringify({ BackendState: 'Stopped', Self: {}, CertDomains: [] })); }
else if (action === 'codex') {
  if (process.env.SCOPE_FIXTURE_SCENARIO === 'probe-failure') process.exit(1);
  const rl = require('node:readline').createInterface({ input: process.stdin });
  rl.on('line', line => {
    const request = JSON.parse(line);
    if (request.method === 'initialize') console.log(JSON.stringify({ id: request.id, result: {} }));
    if (request.method === 'hooks/list') {
      const config = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, 'hooks.json')));
      const hooks = Object.entries(config.hooks).flatMap(([event, groups]) => groups.flatMap(g => (g.hooks || []).map(h => ({ eventName: event[0].toLowerCase() + event.slice(1), statusMessage: h.statusMessage, handlerType: h.type, timeoutSec: h.timeout, async: false, enabled: true, trustStatus: process.env.CODEX_HOME === path.join(home, '.codex') ? 'trusted' : 'untrusted', command: h.command }))));
      console.log(JSON.stringify({ id: request.id, result: { data: [{ hooks }] } }));
    }
  });
}
`;

type Frame = [number, "o", string];
const scenarios = [
  "decline",
  "failure",
  "probe-failure",
  "remote-prerequisite",
  "enablement-symlink",
  "cancel",
  "success",
  "edited",
  "recovery",
];
for (const scenario of scenarios) {
  const root = mkdtempSync(join(tmpdir(), "scope-pty-"));
  const home = join(root, "home"),
    tools = join(root, "bin");
  mkdirSync(join(home, ".codex"), { recursive: true, mode: 0o700 });
  mkdirSync(tools, { mode: 0o700 });
  if (scenario === "enablement-symlink") {
    const services = join(home, ".config/systemd/user");
    const external = join(root, "existing-enablement");
    mkdirSync(services, { recursive: true, mode: 0o700 });
    mkdirSync(external, { mode: 0o700 });
    symlinkSync(external, join(services, "default.target.wants"));
  }
  const config = "[features]\nexample = true\n";
  const hooks = JSON.stringify({
    hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "exit 2" }] }] },
  });
  writeFileSync(join(home, ".codex/config.toml"), config, { mode: 0o600 });
  writeFileSync(join(home, ".codex/hooks.json"), hooks, { mode: 0o600 });
  for (const name of ["codex", "systemctl", "loginctl", "tailscale"]) {
    writeFileSync(join(tools, name), fixtureCommand);
    chmodSync(join(tools, name), 0o700);
  }
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${tools}:${process.env.PATH}`,
    SCOPE_FIXTURE_SCENARIO: scenario,
    TERM: "xterm-256color",
  };
  const frames: Frame[] = [];
  const started = performance.now();
  const add = (text: string) =>
    frames.push([Math.round((performance.now() - started) * 1000) / 1e6, "o", text]);
  add(
    `Synthetic native CLI walkthrough: ${scenario}\r\nService commands, Codex approvals, and Tailscale status are simulated.\r\nThe native collector and observer run normally; no account configuration is used.\r\n\r\n`,
  );
  let text = "";
  const recordPath = join(home, ".local/state/codex-scope-installer/installation.json");
  async function terminal(
    command: string[],
    mode: "setup" | "inspect" | "uninstall" | "purge" | "recovery",
  ) {
    return await new Promise<number>((resolveExit, reject) => {
      const child = spawn(
        "script",
        ["-qefc", `stty rows 42 cols 120; exec ${command.map(quote).join(" ")}`, "/dev/null"],
        { env, stdio: ["pipe", "pipe", "pipe"] },
      );
      let pending = "",
        handled = new Set<string>();
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`${scenario}/${mode} timed out: ${pending.slice(-500)}`));
      }, 90_000);
      const send = (value: string) => {
        setTimeout(() => child.stdin.write(value), 80);
      };
      const once = (key: string, pattern: RegExp, answer: () => void) => {
        if (!handled.has(key) && pattern.test(pending)) {
          handled.add(key);
          answer();
        }
      };
      child.stdout.on("data", (data: Buffer) => {
        const chunk = data.toString();
        add(chunk);
        text += chunk;
        pending += chunk;
        once("remote", /Use Tailscale.*\[y\/N\]: /, () =>
          send(scenario === "remote-prerequisite" ? "y\n" : "n\n"),
        );
        once("config", /Codex configuration directory.*: /, () => send("\n"));
        once("consent", /Read Codex config.toml.*\[y\/N\]: /, () =>
          send(scenario === "decline" ? "n\n" : "y\n"),
        );
        once("customize", /Customize these suggestions.*\[y\/N\]: /, () => send("n\n"));
        once("apply", /Apply these changes.*\[y\/N\]: /, () => send("y\n"));
        once("approval", /Have you approved those hooks.*\[y\/N\]: /, () =>
          send(scenario === "cancel" ? "\x03" : "y\n"),
        );
        once("live", /Did the task finish normally.*\[y\/N\]: /, () => {
          const marker = pending.match(/Run printf '(scope-check-[a-f0-9]+)/)?.[1];
          const record = JSON.parse(readFileSync(recordPath, "utf8"));
          if (!marker) return reject(new Error("Test marker prompt missing"));
          const sent = spawnSync(observer, [join(record.runtime, "ingest.sock")], {
            input: JSON.stringify({
              hook_event_name: "PreToolUse",
              session_id: "synthetic-terminal-check",
              tool_input: marker,
            }),
            timeout: 2000,
          });
          if (sent.status !== 0) return reject(new Error("Native observer failed"));
          setTimeout(() => send("y\n"), 150);
        });
        once("stopped", /Did that task also finish normally.*\[y\/N\]: /, () => send("y\n"));
        once("record", /Read the installation record.*\[y\/N\]: /, () => send("y\n"));
        once("recover", /Undo its recorded changes now.*\[y\/N\]: /, () => send("y\n"));
        once("uninstall", /Remove unchanged Scope hooks.*\[y\/N\]: /, () => send("y\n"));
        once("retained", /Also delete unchanged local token.*\[y\/N\]: /, () => send("n\n"));
        once("purge", /Delete retained token.*\[y\/N\]: /, () => send("y\n"));
      });
      child.stderr.on("data", (data) => {
        add(data.toString());
        text += data.toString();
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        clearTimeout(timeout);
        resolveExit(code ?? 1);
      });
    });
  }
  try {
    const code = await terminal([binary, "setup"], "setup");
    if (["success", "edited", "recovery"].includes(scenario)) {
      if (code !== 0 || !text.includes("Live capture and collector-stop checks passed"))
        throw new Error(`${scenario} setup failed: ${text.slice(-900)}`);
      const management = join(dirname(recordPath), "manage.sh");
      if (scenario === "edited") {
        const r = JSON.parse(readFileSync(recordPath, "utf8"));
        writeFileSync(r.unit, readFileSync(r.unit, "utf8") + "\n# changed by fixture user\n");
        add("\r\nFixture adds a user edit to the installed service before removal.\r\n");
        const removed = await terminal([management, "uninstall"], "uninstall");
        if (removed === 0 || !text.includes("Service file was edited; preserved"))
          throw new Error("Edited service was not preserved");
      } else if (scenario === "recovery") {
        const r = JSON.parse(readFileSync(recordPath, "utf8"));
        r.phase = "installing";
        writeFileSync(recordPath, JSON.stringify(r));
        add("\r\nFixture simulates a crash before the final success record was written.\r\n");
        if ((await terminal([management], "recovery")) !== 0)
          throw new Error("Interrupted install recovery failed");
      } else {
        if ((await terminal([management, "inspect"], "inspect")) !== 0)
          throw new Error("Copied management inspect failed");
        if ((await terminal([management, "uninstall"], "uninstall")) !== 0)
          throw new Error("Copied management uninstall failed");
        if (readFileSync(join(home, ".codex/config.toml"), "utf8") !== config)
          throw new Error("Codex config changed");
        deepStrictEqual(
          JSON.parse(readFileSync(join(home, ".codex/hooks.json"), "utf8")),
          JSON.parse(hooks),
          "Unrelated hooks changed",
        );
        if ((await terminal([management, "purge"], "purge")) !== 0)
          throw new Error("Copied management purge failed");
      }
    } else if (scenario === "cancel") {
      if (code === 0 || !text.includes("Rollback finished"))
        throw new Error("Cancellation did not roll back");
      if (JSON.parse(readFileSync(recordPath, "utf8")).phase !== "removed")
        throw new Error("Cancelled setup record was not removed");
    } else {
      if (code === 0 || existsSync(recordPath))
        throw new Error(`${scenario} unexpectedly installed`);
      if (
        scenario === "enablement-symlink" &&
        !text.includes("Expected a directory without symlinks")
      )
        throw new Error("Service enablement symlink refusal was not reported");
      if (
        readFileSync(join(home, ".codex/config.toml"), "utf8") !== config ||
        readFileSync(join(home, ".codex/hooks.json"), "utf8") !== hooks
      )
        throw new Error("Declined or failed setup changed configuration");
    }
    writeFileSync(
      join(output, `${scenario}.cast`),
      JSON.stringify({
        version: 2,
        width: 120,
        height: 42,
        title: `Native guided setup: ${scenario}`,
        env: { TERM: "xterm-256color" },
      }) +
        "\n" +
        frames.map((frame) => JSON.stringify(frame)).join("\n") +
        "\n",
    );
    writeFileSync(join(output, `${scenario}.txt`), text);
    console.log(`Recorded ${scenario}`);
  } finally {
    const pidFile = join(home, ".fixture-service.pid");
    if (existsSync(pidFile)) {
      try {
        process.kill(Number(readFileSync(pidFile, "utf8")), "SIGTERM");
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    rmSync(root, { recursive: true, force: true });
  }
}
writeFileSync(
  join(output, "scenarios.json"),
  JSON.stringify(
    {
      environment: "Linux VM, native CLI in util-linux script PTY, 120 columns × 42 rows",
      scenarios,
      binary_sha256: binaryHash,
      evidence:
        "Actual CLI prompts, config/recovery writes and native collector/observer. Service commands, Codex registration/approval metadata and Tailscale prerequisite status are synthetic. Real Codex compatibility and private HTTPS are verified separately where available.",
    },
    null,
    2,
  ),
);
