import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";

const [command, ...args] = process.argv.slice(2);
if (!command || !process.env.DISPLAY)
  throw new Error("Run a validation command inside the documented xvfb-run display.");
const hasManager = () =>
  /window id # 0x[1-9a-f]/i.test(
    execFileSync("xprop", ["-root", "_NET_SUPPORTING_WM_CHECK"], { encoding: "utf8" }),
  );
if (hasManager())
  throw new Error(
    "Validation needs an unused Xvfb display. An existing window manager will not be replaced.",
  );
const root = await mkdtemp(path.join(os.tmpdir(), "scope-desktop-"));
await writeFile(
  path.join(root, "rc.xml"),
  '<?xml version="1.0"?><openbox_config xmlns="http://openbox.org/3.4/rc"><desktops><number>1</number></desktops><applications><application class="*"><decor>no</decor></application></applications></openbox_config>',
);
const manager = spawn("openbox", ["--config-file", path.join(root, "rc.xml")], { stdio: "ignore" });
let managerFailure;
const managerExit = once(manager, "exit").catch((error) => {
  managerFailure = error;
});
let child: ChildProcess | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    child?.kill(signal);
  });
try {
  const deadline = performance.now() + 5000;
  while (!hasManager()) {
    if (managerFailure || manager.exitCode !== null || performance.now() > deadline)
      throw new Error("Isolated Openbox did not become ready. Install openbox and x11-utils.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child = spawn(command, args, { stdio: "inherit" });
  const [code, signal] = await once(child, "exit");
  process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143);
} finally {
  manager.kill("SIGTERM");
  const deadline = setTimeout(() => manager.kill("SIGKILL"), 3000);
  await managerExit;
  clearTimeout(deadline);
  await rm(root, { recursive: true, force: true });
}
