import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { locations, readRouteKey, validateConfig } from "../src/config.mjs";
import {
  codexEnvironment,
  codexLaunchArgs,
  resolveLaunchMode,
} from "../src/launch.mjs";
import { summaryEnvironment } from "../src/luna-summary.mjs";
import { runSelector } from "../src/task-router.mjs";

const cli = resolve("bin/ares.mjs");
const task = {
  kind: "simple_code",
  description: "Update one synthetic utility.",
  failure_count: 0,
  uncertainty: "low",
  scope: "local",
  effects_known: true,
  data_class: "synthetic",
};

test("mode command changes one config without changing session home", () => {
  const dir = mkdtempSync(join(tmpdir(), "ares-modes-"));
  const env = {
    ...process.env,
    ARES_CONFIG: join(dir, "config.json"),
    ARES_HOME: join(dir, "data"),
  };
  const invoke = (args, input) =>
    spawnSync(process.execPath, [cli, ...args], {
      env,
      input,
      encoding: "utf8",
    });
  try {
    assert.equal(
      invoke(
        ["configure", "--provider", "typesafe", "--key-stdin"],
        "test-main-key\n",
      ).status,
      0,
    );
    const before = locations(env).codexHome;
    assert.equal(invoke(["mode"]).stdout.trim(), "adaptive");
    assert.equal(invoke(["mode", "multi-agent"]).stdout.trim(), "multi-agent");
    assert.equal(invoke(["mode", "adaptive"]).stdout.trim(), "adaptive");
    assert.equal(locations(env).codexHome, before);
    const saved = JSON.parse(readFileSync(env.ARES_CONFIG, "utf8"));
    assert.equal(saved.provider, "typesafe");
    assert.equal(saved.apiKey, "test-main-key");
    assert.equal(saved.maxLeaseSteps, 5);
    assert.equal(saved.mode, "adaptive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup accepts either mode with the same adopted binary and home", () => {
  const dir = mkdtempSync(join(tmpdir(), "ares-mode-setup-"));
  const binary = join(dir, "codex");
  const env = {
    ...process.env,
    ARES_CONFIG: join(dir, "config.json"),
    ARES_HOME: join(dir, "data"),
  };
  writeFileSync(
    binary,
    [
      "#!/bin/sh",
      "# CODEX_STEP_CONTROLLER_CONTEXT_V3 CODEX_TASK_ROUTER_SOCKET",
      "# Jev requires its bridge Astra Ares Luna Ares Sol Ares Sol 6.1 Ares",
      "printf 'codex-cli 0.160.1\\n'",
    ].join("\n") + "\n",
  );
  chmodSync(binary, 0o700);
  writeFileSync(join(dir, "codex-code-mode-host"), "fixture");
  const invoke = (args) =>
    spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8" });
  try {
    for (const mode of ["adaptive", "multi-agent"]) {
      const result = invoke([
        "setup",
        "--binary",
        binary,
        "--mode",
        mode,
        "--provider",
        "typesafe",
      ]);
      assert.equal(result.status, 0, result.stderr);
      const saved = JSON.parse(readFileSync(env.ARES_CONFIG, "utf8"));
      assert.equal(saved.mode, mode);
      assert.equal(saved.codexBinary, binary);
      assert.equal(locations(env).codexHome, join(dir, "data", "codex-home"));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("launch mode override is temporary and user model/effort arguments remain last", () => {
  const config = validateConfig({ provider: "typesafe" });
  const resolved = resolveLaunchMode(
    [
      "--ares-mode",
      "multi-agent",
      "-m",
      "gpt-6-sol",
      "-c",
      'model_reasoning_effort="high"',
    ],
    config,
  );
  assert.equal(config.mode, "adaptive");
  assert.equal(resolved.mode, "multi-agent");
  const args = codexLaunchArgs(resolved.forwarded, resolved.mode);
  assert.deepEqual(args.slice(-4), [
    "-m",
    "gpt-6-sol",
    "-c",
    'model_reasoning_effort="high"',
  ]);
  assert(
    args.some(
      (arg) =>
        arg.startsWith("developer_instructions=") &&
        arg.includes("spawn_routed_agent"),
    ),
  );
  for (const role of [
    "worker",
    "simple_worker",
    "executor",
    "luna_worker",
    "luna_executor",
    "reviewer",
    "reviewer_core",
    "researcher",
  ]) {
    assert(
      args.some(
        (arg) =>
          arg.startsWith(`agents.${role}.config_file=`) &&
          arg.includes("/profiles/agents/"),
      ),
    );
    assert(args.some((arg) => arg.startsWith(`agents.${role}.description=`)));
  }
  const adaptive = codexLaunchArgs([], "adaptive");
  assert(adaptive.includes("agents.enabled=false"));
  assert(
    !adaptive.some(
      (arg) => arg.startsWith("agents.") && arg !== "agents.enabled=false",
    ),
  );
  assert(!adaptive.some((arg) => arg.startsWith("developer_instructions=")));
  assert(adaptive.includes('model="Astra-Jev"'));
  assert(adaptive.includes('model_reasoning_effort="medium"'));
  assert.deepEqual(
    codexLaunchArgs(["-c", "agents.enabled=true"], "adaptive").slice(-2),
    ["-c", "agents.enabled=true"],
  );
  assert.throws(() => resolveLaunchMode(["--ares-mode"], config), /requires/);
  assert.throws(
    () => resolveLaunchMode(["--ares-mode", "--model", "x"], config),
    /requires/,
  );
});

test("adaptive session and Luna summary discard inherited router sockets and custom keys", () => {
  const base = {
    CODEX_TASK_ROUTER_SOCKET: "/stale/router.sock",
    CODEX_STEP_CONTROLLER_SOCKET: "/stale/step.sock",
    OPENROUTER_API_KEY: "main-secret",
    ZEN_API_KEY: "route-secret",
    CUSTOM_MAIN_KEY: "custom-main",
    CUSTOM_ROUTE_KEY: "custom-route",
    PATH: "/bin",
  };
  const config = {
    apiKeyEnv: "CUSTOM_MAIN_KEY",
    routeApiKeyEnv: "CUSTOM_ROUTE_KEY",
  };
  const adaptive = codexEnvironment(
    base,
    config,
    "/shared/home",
    "/new/step.sock",
  );
  assert.equal(adaptive.CODEX_TASK_ROUTER_SOCKET, undefined);
  assert.equal(adaptive.CODEX_STEP_CONTROLLER_SOCKET, "/new/step.sock");
  assert.equal(adaptive.CUSTOM_ROUTE_KEY, undefined);
  assert.equal(adaptive.CUSTOM_MAIN_KEY, undefined);
  const multi = codexEnvironment(
    base,
    config,
    "/shared/home",
    "/new/step.sock",
    "/new/router.sock",
  );
  assert.equal(multi.CODEX_TASK_ROUTER_SOCKET, "/new/router.sock");
  const summary = summaryEnvironment(base, "/summary/home", [
    "CUSTOM_MAIN_KEY",
    "CUSTOM_ROUTE_KEY",
  ]);
  assert.equal(summary.CODEX_HOME, "/summary/home");
  assert.equal(summary.CODEX_TASK_ROUTER_SOCKET, undefined);
  assert.equal(summary.CODEX_STEP_CONTROLLER_SOCKET, undefined);
  assert.equal(summary.ZEN_API_KEY, undefined);
  assert.equal(summary.CUSTOM_ROUTE_KEY, undefined);
  assert.equal(summary.CUSTOM_MAIN_KEY, undefined);
  assert.equal(summary.PATH, "/bin");
});

test("route credential matches its provider and never borrows another provider key", () => {
  assert.deepEqual(
    readRouteKey(
      validateConfig({ provider: "typesafe", apiKey: "main-typesafe" }),
      {},
    ),
    {
      provider: "typesafe",
      key: "main-typesafe",
    },
  );
  assert.throws(
    () =>
      readRouteKey(
        validateConfig({ provider: "openrouter", apiKey: "openrouter-only" }),
        {},
      ),
    /routeProvider/,
  );
  assert.deepEqual(
    readRouteKey(
      validateConfig({
        provider: "openrouter",
        routeProvider: "zen",
        routeApiKeyEnv: "ROUTE_FIXTURE",
      }),
      { ROUTE_FIXTURE: "zen-key" },
    ),
    {
      provider: "zen",
      key: "zen-key",
    },
  );
  assert.throws(
    () => validateConfig({ provider: "typesafe", maxLeaseSteps: 10 }),
    /maxLeaseSteps/,
  );
});

test("selector subprocess receives only the chosen route key and project-neutral task", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ares-route-env-"));
  const script = join(dir, "inspect.py");
  writeFileSync(
    script,
    [
      "import json, os, sys",
      "task = json.load(sys.stdin)",
      "print(json.dumps({'task': task, 'provider': os.environ.get('ARES_ROUTE_PROVIDER'), 'zen': os.environ.get('ZEN_API_KEY'), 'typesafe': os.environ.get('TYPESAFE_API_KEY'), 'openrouter': os.environ.get('OPENROUTER_API_KEY')}))",
    ].join("\n") + "\n",
  );
  try {
    const result = await runSelector(task, {
      script,
      routeCredential: { provider: "zen", key: "route-only" },
    });
    assert.deepEqual(result.task, task);
    assert.equal(result.provider, "zen");
    assert.equal(result.zen, "route-only");
    assert.equal(result.typesafe, null);
    assert.equal(result.openrouter, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
