import { spawn } from "node:child_process";
import { chmodSync } from "node:fs";
import { createServer } from "node:net";

const MAX_FRAME = 16_384;
const SOL = "gpt-6.1-sol";
const SOL_ALIAS = "Sol-6.1-Jev";
const TASK_KINDS = new Set([
  "core_implementation",
  "simple_code",
  "execution",
  "review",
  "review_core",
  "research",
]);
const TASK_FIELDS = new Set([
  "kind",
  "description",
  "failure_count",
  "uncertainty",
  "scope",
  "effects_known",
  "data_class",
]);
const SAFE_ERRORS = new Set([
  "Invalid route envelope",
  "Invalid requested role",
  "Missing or invalid task metadata",
  "Duplicate route ID",
  "Task router capacity reached",
  "Native route confirmation does not match pending decision",
]);

function validId(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

export function validateRoute(message) {
  if (
    message?.protocol !== 1 ||
    message.type !== "route" ||
    !validId(message.routeId) ||
    !validId(message.parentThreadId)
  )
    throw new Error("Invalid route envelope");
  if (
    message.requestedRole !== undefined &&
    (typeof message.requestedRole !== "string" ||
      message.requestedRole.length > 128)
  )
    throw new Error("Invalid requested role");
  const task = message.task;
  if (
    !task ||
    typeof task !== "object" ||
    Array.isArray(task) ||
    Object.keys(task).length !== TASK_FIELDS.size ||
    Object.keys(task).some((key) => !TASK_FIELDS.has(key)) ||
    !TASK_KINDS.has(task.kind) ||
    typeof task.description !== "string" ||
    !task.description.trim() ||
    task.description.length > 400 ||
    /[\r\n]|```/.test(task.description) ||
    !Number.isInteger(task.failure_count) ||
    task.failure_count < 0 ||
    task.failure_count > 100 ||
    !["low", "moderate", "high"].includes(task.uncertainty) ||
    !["local", "cross_module", "core"].includes(task.scope) ||
    typeof task.effects_known !== "boolean" ||
    !["public", "synthetic"].includes(task.data_class)
  )
    throw new Error("Missing or invalid task metadata");
  return task;
}

function fixedDecision(task) {
  if (task.kind === "review" || task.kind === "review_core")
    return {
      model: "gpt-6-astra",
      effort: task.kind === "review" ? "low" : "medium",
      role: task.kind === "review" ? "reviewer" : "reviewer_core",
      source: "fixed_rule",
      reason: task.kind,
    };
  if (task.kind === "research")
    return {
      model: SOL,
      effort: "high",
      role: "researcher",
      source: "fixed_rule",
      reason: "research_fixed_high",
    };
  if (task.kind === "core_implementation" || task.scope === "core")
    return {
      model: SOL,
      effort: "high",
      role: "worker",
      source: "fixed_rule",
      reason: "core_fixed_high",
    };
  return null;
}

function fallback(task, reason) {
  return {
    model: SOL,
    effort: "high",
    role: task.kind === "simple_code" ? "simple_worker" : "executor",
    source: "fallback",
    reason,
  };
}

function telemetry(result) {
  const usage = result?.usage;
  return {
    confidence:
      typeof result?.confidence === "number" &&
      Number.isFinite(result.confidence)
        ? result.confidence
        : null,
    live_attempted:
      typeof result?.live_attempted === "boolean"
        ? result.live_attempted
        : null,
    usage:
      usage && typeof usage === "object" && !Array.isArray(usage)
        ? {
            input_tokens:
              Number.isSafeInteger(usage.input_tokens) &&
              usage.input_tokens >= 0
                ? usage.input_tokens
                : null,
            output_tokens:
              Number.isSafeInteger(usage.output_tokens) &&
              usage.output_tokens >= 0
                ? usage.output_tokens
                : null,
          }
        : null,
    cost:
      typeof result?.cost === "number" &&
      Number.isFinite(result.cost) &&
      result.cost >= 0
        ? result.cost
        : null,
  };
}

export async function runSelector(
  task,
  { script, signal, timeoutMs = 50_000, routeCredential } = {},
) {
  signal?.throwIfAborted();
  return new Promise((resolve) => {
    const credentialName =
      routeCredential?.provider === "zen" ? "ZEN_API_KEY" : "TYPESAFE_API_KEY";
    const child = spawn("python3", [script], {
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "ignore"],
      env: routeCredential
        ? {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            LANG: process.env.LANG,
            [credentialName]: routeCredential.key,
            ARES_ROUTE_PROVIDER: routeCredential.provider,
          }
        : process.env,
    });
    let stdout = "",
      finished = false,
      timedOut = false,
      aborted = false;
    const kill = () => {
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already exited */
        }
      } else child.kill("SIGKILL");
    };
    const onAbort = () => {
      aborted = true;
      kill();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 65_536) kill();
    });
    child.stdin.on("error", () => {});
    child.on("error", () => {});
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (aborted) {
        resolve({ status: "cancelled" });
        return;
      }
      if (timedOut) {
        resolve({ status: "timeout" });
        return;
      }
      if (code !== 0 || stdout.length > 65_536) {
        resolve({ status: "unavailable" });
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({ status: "unavailable" });
      }
    });
    child.stdin.end(JSON.stringify(task));
  });
}

export async function chooseRoute(task, { selector, signal } = {}) {
  const fixed = fixedDecision(task);
  if (fixed) return fixed;
  if (task.failure_count > 0)
    return fallback(task, "prior_failure_requires_root");
  if (
    task.uncertainty === "high" ||
    task.scope !== "local" ||
    !task.effects_known
  )
    return fallback(task, "uncertain_scope_requires_root");
  let result;
  try {
    result = await selector(task, signal);
  } catch {
    return signal?.aborted ? null : fallback(task, "triage_unavailable");
  }
  if (signal?.aborted || result?.status === "cancelled") return null;
  if (result?.status === "timeout")
    return {
      ...fallback(task, "triage_timeout"),
      telemetry: telemetry(result),
    };
  if (
    result?.status !== "ok" ||
    result.mode !== "live" ||
    typeof result.confidence !== "number" ||
    !Number.isFinite(result.confidence) ||
    result.confidence < 0.8 ||
    result.confidence > 1
  )
    return {
      ...fallback(task, "triage_unavailable"),
      telemetry: telemetry(result),
    };
  if (
    result.model === SOL &&
    result.effort === "medium" &&
    result.ares_model_alias === SOL_ALIAS
  )
    return {
      model: SOL_ALIAS,
      effort: "medium",
      role: task.kind === "simple_code" ? "simple_worker" : "executor",
      source: "jev_live",
      reason: "sol_adaptive",
      telemetry: telemetry(result),
    };
  if (result.model === "gpt-6-luna" && result.effort === "max")
    return {
      model: "gpt-6-luna",
      effort: "max",
      role: task.kind === "simple_code" ? "luna_worker" : "luna_executor",
      source: "jev_live",
      reason: "luna_max",
      telemetry: telemetry(result),
    };
  return {
    ...fallback(task, "invalid_selector_choice"),
    telemetry: telemetry(result),
  };
}

function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length);
  return Buffer.concat([size, body]);
}

export class TaskRouter {
  constructor({
    socketPath,
    script,
    routeCredential,
    record = () => {},
    selector,
    now = () => Date.now(),
    pendingTtlMs = 300_000,
    replayTtlMs = 600_000,
    maxPendingRoutes = 128,
    maxRememberedIds = 2048,
  }) {
    if (
      ![pendingTtlMs, replayTtlMs, maxPendingRoutes, maxRememberedIds].every(
        (n) => Number.isSafeInteger(n) && n > 0,
      ) ||
      maxRememberedIds < maxPendingRoutes
    )
      throw new Error("Invalid task router limits");
    Object.assign(this, { socketPath, script, routeCredential, record });
    Object.assign(this, {
      now,
      pendingTtlMs,
      replayTtlMs,
      maxPendingRoutes,
      maxRememberedIds,
    });
    this.selector =
      selector ??
      ((task, signal) =>
        runSelector(task, { script, signal, routeCredential }));
    this.pending = new Map();
    this.inflightRoutes = new Set();
    this.usedRouteIds = new Map();
    this.usedChildIds = new Map();
    this.sockets = new Set();
    this.completedRoutes = 0;
  }

  pruneExpired() {
    const now = this.now();
    for (const [id, decision] of this.pending)
      if (decision.expiresAt <= now) this.pending.delete(id);
    for (const ids of [this.usedRouteIds, this.usedChildIds])
      for (const [id, expiresAt] of ids) if (expiresAt <= now) ids.delete(id);
  }

  async handle(message, signal = new AbortController().signal) {
    this.pruneExpired();
    if (message?.protocol === 1 && message.type === "route_applied") {
      const pending = this.pending.get(message.routeId);
      if (
        !pending ||
        message.parentThreadId !== pending.parentThreadId ||
        !validId(message.childThreadId) ||
        this.usedChildIds.has(message.childThreadId) ||
        message.model !== pending.model ||
        message.effort !== pending.effort ||
        message.confirmation !== "native_child_context_captured"
      )
        throw new Error(
          "Native route confirmation does not match pending decision",
        );
      if (this.usedChildIds.size >= this.maxRememberedIds)
        throw new Error("Task router capacity reached");
      this.pending.delete(message.routeId);
      this.usedChildIds.set(
        message.childThreadId,
        this.now() + this.replayTtlMs,
      );
      this.completedRoutes++;
      this.record({
        type: "task_route_applied",
        routeId: message.routeId,
        parentThreadId: message.parentThreadId,
        childThreadId: message.childThreadId,
        model: pending.model,
        effort: pending.effort,
        role: pending.role,
        source: pending.source,
        reason: pending.reason,
        confirmation: message.confirmation,
      });
      return {
        protocol: 1,
        type: "route_applied_ack",
        routeId: message.routeId,
      };
    }
    const task = validateRoute(message);
    if (this.usedRouteIds.has(message.routeId))
      throw new Error("Duplicate route ID");
    if (
      this.pending.size + this.inflightRoutes.size >= this.maxPendingRoutes ||
      this.usedRouteIds.size >= this.maxRememberedIds
    )
      throw new Error("Task router capacity reached");
    this.usedRouteIds.set(
      message.routeId,
      this.now() + this.pendingTtlMs + this.replayTtlMs,
    );
    this.inflightRoutes.add(message.routeId);
    let decision;
    try {
      decision = await chooseRoute(task, {
        selector: this.selector,
        signal,
      });
    } finally {
      this.inflightRoutes.delete(message.routeId);
    }
    if (signal.aborted || !decision) return null;
    this.pending.set(message.routeId, {
      ...decision,
      parentThreadId: message.parentThreadId,
      expiresAt: this.now() + this.pendingTtlMs,
    });
    this.record({
      type: "task_route_decision",
      routeId: message.routeId,
      parentThreadId: message.parentThreadId,
      kind: task.kind,
      model: decision.model,
      effort: decision.effort,
      role: decision.role,
      source: decision.source,
      reason: decision.reason,
      confidence: decision.telemetry?.confidence ?? null,
      live_attempted: decision.telemetry?.live_attempted ?? null,
      usage: decision.telemetry?.usage ?? null,
      cost: decision.telemetry?.cost ?? null,
    });
    const { model, effort, role, source, reason } = decision;
    return {
      protocol: 1,
      type: "route_decision",
      routeId: message.routeId,
      model,
      effort,
      role,
      source,
      reason,
    };
  }

  async start() {
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      const abort = new AbortController();
      let bytes = Buffer.alloc(0),
        processing = false;
      const fail = (message) => {
        abort.abort();
        if (!socket.destroyed)
          socket.end(
            frame({
              protocol: 1,
              type: "error",
              code: "route_rejected",
              message,
            }),
          );
      };
      socket.on("data", (chunk) => {
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length < 4) return;
        const length = bytes.readUInt32BE(0);
        if (
          !length ||
          length > MAX_FRAME ||
          bytes.length > length + 4 ||
          processing
        ) {
          fail("Invalid or overlapping native frame");
          return;
        }
        if (bytes.length < length + 4) return;
        processing = true;
        let message;
        try {
          message = JSON.parse(bytes.subarray(4));
        } catch {
          fail("Invalid native JSON");
          return;
        }
        this.handle(message, abort.signal)
          .then((reply) => {
            if (reply && !abort.signal.aborted) socket.end(frame(reply));
          })
          .catch((error) =>
            fail(
              SAFE_ERRORS.has(error?.message)
                ? error.message
                : "Task routing failed",
            ),
          );
      });
      socket.on("error", () => {});
      socket.on("close", () => {
        abort.abort();
        this.sockets.delete(socket);
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, resolve);
    });
    chmodSync(this.socketPath, 0o600);
  }

  async stop() {
    for (const socket of this.sockets) socket.destroy();
    await new Promise((resolve) => this.server.close(resolve));
    this.pending.clear();
    this.inflightRoutes.clear();
    this.usedRouteIds.clear();
    this.usedChildIds.clear();
  }
}
