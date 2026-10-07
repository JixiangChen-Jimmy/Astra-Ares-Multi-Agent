import { Worker } from "node:worker_threads";
import { execFile } from "node:child_process";
import { lstat, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";

const DEFAULT_TIMEOUT_MS = 32_000;
const DEFAULT_MAX_WORKERS = 8;
const IDLE_MS = 10 * 60_000;
const WORKER_URL = new URL("./evaluator-worker.mjs", import.meta.url);
const execFileAsync = promisify(execFile);
const EVENT_TYPES = new Set([
  "provider_request",
  "provider_error",
  "provider_retry",
  "luna_summary",
  "summary_evaluator_fallback",
  "luna_summary_attempt",
  "luna_summary_retry",
]);

async function childIdentity(pid) {
  try {
    if (process.platform === "linux") {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return { parent: Number(fields[1]), started: fields[19] };
    }
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync(
        "ps",
        ["-o", "ppid=", "-o", "lstart=", "-p", String(pid)],
        { timeout: 1000 },
      );
      const match = stdout.match(/^\s*(\d+)\s+(.+)$/m);
      return match
        ? { parent: Number(match[1]), started: match[2].trim() }
        : null;
    }
    return null;
  } catch {
    return null;
  }
}

async function cleanupHome(home) {
  if (typeof home !== "string") return;
  const path = resolve(home);
  if (
    dirname(path) !== resolve(tmpdir()) ||
    !/^ares-luna-[\w-]+$/.test(basename(path))
  )
    return;
  try {
    if (!(await lstat(path)).isDirectory()) return;
    await rm(path, { recursive: true, force: true });
  } catch {
    /* worker may already have removed it */
  }
}

function terminateChild(pid, child) {
  // Capture the OS identity before signalling so a recycled PID is never targeted.
  void (async () => {
    const original = await child.identity;
    const matches = async () => {
      const current = await childIdentity(pid);
      return (
        original?.parent === process.pid &&
        current?.parent === process.pid &&
        current.started === original.started
      );
    };
    if (await matches()) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already exited */
      }
    }
    const timer = setTimeout(() => {
      void (async () => {
        if (await matches()) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* already exited */
          }
        }
        const cleanupTimer = setTimeout(
          () => void cleanupHome(child.home),
          250,
        );
        cleanupTimer.unref();
      })();
    }, 750);
    timer.unref();
  })();
}

function fallback(state, reason, elapsedMs) {
  const effort = state.supportedEfforts?.includes(state.previousEffort)
    ? state.previousEffort
    : state.supportedEfforts?.includes("medium")
      ? "medium"
      : state.supportedEfforts?.[0];
  if (!effort) throw new Error("No supported fallback effort");
  return {
    effort,
    leaseSteps: 1,
    jevMs: elapsedMs,
    provider: "fallback",
    evaluatedModel: state.model,
    attempts: 0,
    requestStats: { fallback: true, reason },
  };
}

export class IsolatedEvaluator {
  constructor({
    config,
    binary,
    home,
    record = () => {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxWorkers = DEFAULT_MAX_WORKERS,
    workerUrl = WORKER_URL,
  }) {
    Object.assign(this, {
      config,
      binary,
      home,
      record,
      timeoutMs,
      maxWorkers,
      workerUrl,
      acceptsFullContext: true,
    });
    this.workers = new Map();
    this.nextId = 0;
    this.closed = false;
  }

  createSlot(key) {
    const worker = new Worker(this.workerUrl, {
      workerData: { config: this.config, binary: this.binary, home: this.home },
    });
    const slot = {
      worker,
      key,
      pending: null,
      children: new Map(),
      lastUsed: Date.now(),
      idleTimer: null,
    };
    this.workers.set(key, slot);
    worker.on("message", (message) => {
      if (!message || typeof message !== "object") return;
      if (
        message.type === "child_spawn" &&
        Number.isSafeInteger(message.pid) &&
        message.pid > 0
      ) {
        const child = {
          home: message.home,
          identity: childIdentity(message.pid),
        };
        if (this.workers.get(key) === slot)
          slot.children.set(message.pid, child);
        else terminateChild(message.pid, child);
        return;
      }
      if (this.workers.get(key) !== slot) return;
      if (message.type === "child_close" && Number.isSafeInteger(message.pid)) {
        slot.children.delete(message.pid);
      } else if (
        message.type === "record" &&
        EVENT_TYPES.has(message.event?.type)
      ) {
        this.record(message.event);
      } else if (message.type === "result" && slot.pending?.id === message.id) {
        slot.pending.finish(message.decision);
      } else if (
        message.type === "failure" &&
        slot.pending?.id === message.id
      ) {
        slot.pending.fail("worker_failure");
      }
    });
    worker.on("error", () => slot.pending?.fail("worker_failure"));
    worker.on("exit", () => {
      if (slot.pending) slot.pending.fail("worker_failure");
      else this.dispose(slot);
    });
    return slot;
  }

  dispose(slot) {
    if (this.workers.get(slot.key) !== slot) return;
    this.workers.delete(slot.key);
    clearTimeout(slot.idleTimer);
    slot.worker.terminate().catch(() => {});
    // Luna app-server is an OS process. Worker termination cannot run its finally block.
    for (const [pid, child] of slot.children) terminateChild(pid, child);
    slot.children.clear();
  }

  chooseSlot(trace) {
    const key = trace.threadId || `unscoped-${++this.nextId}`;
    const existing = this.workers.get(key);
    if (existing && !existing.pending) {
      clearTimeout(existing.idleTimer);
      existing.idleTimer = null;
      return existing;
    }
    const selectedKey = existing ? `${key}:concurrent:${++this.nextId}` : key;
    if (this.workers.size >= this.maxWorkers) {
      const idle = [...this.workers.values()]
        .filter((slot) => !slot.pending)
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!idle) return null;
      this.dispose(idle);
    }
    return this.createSlot(selectedKey);
  }

  decide(state, { signal, trace = {} } = {}) {
    signal?.throwIfAborted();
    if (this.closed) return Promise.reject(new Error("Evaluator is closed"));
    const started = performance.now();
    return new Promise((resolve, reject) => {
      let slot;
      let settled = false;
      const elapsed = () => Math.round(performance.now() - started);
      const finish = (decision, reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (slot) {
          slot.pending = null;
          slot.lastUsed = Date.now();
          if (reason || slot.key.startsWith("unscoped-")) this.dispose(slot);
          else {
            slot.idleTimer = setTimeout(() => this.dispose(slot), IDLE_MS);
            slot.idleTimer.unref();
          }
        }
        if (reason) {
          this.record({
            type: "summary_evaluator_fallback",
            ...trace,
            phase: "outer_watchdog",
            reason,
            effort: state.supportedEfforts?.includes(state.previousEffort)
              ? state.previousEffort
              : state.supportedEfforts?.includes("medium")
                ? "medium"
                : state.supportedEfforts?.[0],
            leaseSteps: 1,
            elapsedMs: elapsed(),
          });
          try {
            resolve(fallback(state, reason, elapsed()));
          } catch (error) {
            reject(error);
          }
        } else resolve(decision);
      };
      const abort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (slot) this.dispose(slot);
        reject(signal.reason);
      };
      const timer = setTimeout(() => finish(null, "timeout"), this.timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        slot = this.chooseSlot(trace);
        if (!slot) return finish(null, "worker_capacity");
        const id = ++this.nextId;
        slot.pending = {
          id,
          finish: (decision) => finish(decision),
          fail: (reason) => finish(null, reason),
        };
        slot.worker.postMessage({ type: "decide", id, state, trace });
        if (signal?.aborted) abort();
      } catch {
        finish(null, "worker_failure");
      }
    });
  }

  async close() {
    this.closed = true;
    for (const slot of [...this.workers.values()]) {
      slot.pending?.fail("worker_failure");
      this.dispose(slot);
    }
  }
}
