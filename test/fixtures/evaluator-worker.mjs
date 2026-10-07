import { parentPort } from "node:worker_threads";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let calls = 0;
parentPort.on("message", (message) => {
  calls++;
  if (message.state.latestUserPrompt === "block") {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
    return;
  }
  if (message.state.latestUserPrompt === "spawn-block") {
    const home = mkdtempSync(join(tmpdir(), "ares-luna-"));
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        stdio: "ignore",
        cwd: home,
      },
    );
    writeFileSync(join(home, "pid"), String(child.pid));
    parentPort.postMessage({ type: "child_spawn", pid: child.pid, home });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
    return;
  }
  if (message.state.latestUserPrompt === "crash") process.exit(1);
  parentPort.postMessage({
    type: "result",
    id: message.id,
    decision: { effort: "low", leaseSteps: 1, jevMs: 1, calls },
  });
});
