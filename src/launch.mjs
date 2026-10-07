import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Bridge } from "./bridge.mjs";
import { IsolatedEvaluator } from "./isolated-evaluator.mjs";
import { TaskRouter } from "./task-router.mjs";
import { loadConfig, readRouteKey } from "./config.mjs";
import { assertLocalCliArgs } from "./cli-args.mjs";
const bundledRoles = {
  worker: "Core implementation; Sol 6.1 high.",
  simple_worker: "Bounded local code; routed Sol adaptive or Luna max.",
  executor: "Clear execution; routed Sol adaptive or Luna max.",
  luna_worker: "Simple local code; Luna max.",
  luna_executor: "Clear execution; Luna max.",
  reviewer: "Independent review; Astra low.",
  reviewer_core: "Core implementation review; Astra medium.",
  researcher: "Research and complex read-only analysis; Sol 6.1 high.",
};
const bundledPolicy = new URL("../profiles/ROOT_POLICY.md", import.meta.url);
const bundledSelector = fileURLToPath(
  new URL("../routing/select_model.py", import.meta.url),
);

export function resolveLaunchMode(args, config) {
  const forwarded = [];
  let override;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      forwarded.push(...args.slice(i));
      break;
    }
    if (arg === "--ares-mode") {
      override = args[++i];
      if (!override || override.startsWith("-"))
        throw new Error("--ares-mode requires adaptive or multi-agent");
    } else if (arg.startsWith("--ares-mode=")) override = arg.slice(12);
    else forwarded.push(arg);
  }
  const mode =
    override ??
    config.mode ??
    (config.taskRouting ? "multi-agent" : "adaptive");
  if (!["adaptive", "multi-agent"].includes(mode))
    throw new Error("--ares-mode must be adaptive or multi-agent");
  return { mode, forwarded };
}

export function codexLaunchArgs(args, mode) {
  const options = [
    "-c",
    "features.step_model_switching=true",
    "-c",
    "features.reasoning_effort_override=true",
    "-c",
    'model="Astra-Jev"',
    "-c",
    'model_reasoning_effort="medium"',
  ];
  if (mode === "adaptive") options.push("-c", "agents.enabled=false");
  if (mode === "multi-agent") {
    options.push("-c", "agents.enabled=true");
    options.push("-c", "agents.max_concurrent_threads_per_session=3");
    options.push(
      "-c",
      `developer_instructions=${JSON.stringify(readFileSync(bundledPolicy, "utf8"))}`,
    );
    for (const [role, description] of Object.entries(bundledRoles)) {
      const file = fileURLToPath(
        new URL(`../profiles/agents/${role}.toml`, import.meta.url),
      );
      options.push(
        "-c",
        `agents.${role}.description=${JSON.stringify(description)}`,
      );
      options.push("-c", `agents.${role}.config_file=${JSON.stringify(file)}`);
    }
  }
  return [...options, ...args];
}

export function codexEnvironment(
  base,
  config,
  home,
  bridgeSocket,
  routerSocket,
) {
  const env = {
    ...base,
    CODEX_HOME: home,
    CODEX_STEP_CONTROLLER_SOCKET: bridgeSocket,
  };
  delete env.CODEX_TASK_ROUTER_SOCKET;
  if (routerSocket) env.CODEX_TASK_ROUTER_SOCKET = routerSocket;
  for (const name of [
    "AI_GATEWAY_API_KEY",
    "TYPESAFE_API_KEY",
    "OPENROUTER_API_KEY",
    "ZEN_API_KEY",
    config.apiKeyEnv,
    config.routeApiKeyEnv,
  ].filter(Boolean))
    delete env[name];
  return env;
}
export function verifyBinary(binary) {
  if (!existsSync(binary))
    throw new Error("Patched Codex is missing. Run ares setup.");
  const bytes = readFileSync(binary);
  for (const marker of [
    "CODEX_STEP_CONTROLLER_CONTEXT_V3",
    "CODEX_TASK_ROUTER_SOCKET",
    "Jev requires its bridge",
    "Astra Ares",
    "Luna Ares",
    "Sol Ares",
    "Sol 6.1 Ares",
  ]) {
    if (!bytes.includes(Buffer.from(marker)))
      throw new Error(
        "This Codex binary has no compatible Jev checkpoint. Run ares setup.",
      );
  }
  if (
    execFileSync(binary, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim() !== "codex-cli 0.160.1"
  )
    throw new Error(
      "Unsupported Codex version; rebuild the pinned source with ares setup.",
    );
  if (!existsSync(join(dirname(binary), "codex-code-mode-host")))
    throw new Error("codex-code-mode-host must be beside the patched Codex");
}
export async function launch(args, config = loadConfig()) {
  if (!["darwin", "linux"].includes(process.platform))
    throw new Error("Jev native checkpoint requires macOS or Linux");
  const { mode, forwarded } = resolveLaunchMode(args, config);
  assertLocalCliArgs(forwarded);
  const binary = config.codexBinary ?? config.paths.binary;
  verifyBinary(binary);
  const routeCredential = mode === "multi-agent" ? readRouteKey(config) : null;
  const home = config.codexHome ?? config.paths.codexHome;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (!existsSync(join(home, "config.toml")))
    writeFileSync(
      join(home, "config.toml"),
      'model = "Astra-Jev"\nmodel_provider = "openai"\n',
      { mode: 0o600 },
    );
  const auth = join(
    process.env.CODEX_HOME || join(homedir(), ".codex"),
    "auth.json",
  );
  if (!existsSync(join(home, "auth.json")) && existsSync(auth))
    symlinkSync(auth, join(home, "auth.json"));
  const socketDir = mkdtempSync(join(tmpdir(), "ares-"));
  const runDir = join(
    config.paths.runs,
    new Date().toISOString().replaceAll(":", "-") + "-" + process.pid,
  );
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const log = createWriteStream(join(runDir, "decisions.jsonl"), {
    flags: "a",
    mode: 0o600,
  });
  let logFailed = false;
  log.on("error", () => {
    logFailed = true;
  });
  const record = (event) => {
    if (!logFailed && !log.destroyed)
      log.write(
        JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n",
      );
  };
  const evaluator = new IsolatedEvaluator({ config, binary, home, record });
  const bridge = new Bridge({
    socketPath: join(socketDir, "step.sock"),
    jev: evaluator,
    record,
  });
  const taskRouter =
    mode === "multi-agent"
      ? new TaskRouter({
          socketPath: join(socketDir, "task-router.sock"),
          script: config.taskRouterScript ?? bundledSelector,
          routeCredential,
          record,
        })
      : null;
  const env = codexEnvironment(
    process.env,
    config,
    home,
    bridge.socketPath,
    taskRouter?.socketPath,
  );
  let child;
  const onInt = () => child?.kill("SIGINT"),
    onTerm = () => child?.kill("SIGTERM");
  try {
    await bridge.start();
    if (taskRouter) await taskRouter.start();
    record({
      type: "cli_started",
      version: "0.3.0",
      mode,
      provider: config.provider,
      maxLeaseSteps: config.maxLeaseSteps,
      lunaSummary: config.lunaSummary ?? false,
      taskRouting: Boolean(taskRouter),
    });
    child = spawn(binary, codexLaunchArgs(forwarded, mode), {
      stdio: "inherit",
      env,
    });
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(code ?? (signal ? 130 : 1)));
    });
    record({
      type: "cli_exited",
      exitCode: code,
      confirmedCheckpoints: bridge.completedCheckpoints,
      confirmedRoutes: taskRouter?.completedRoutes ?? 0,
    });
    return code;
  } finally {
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
    await bridge.stop();
    if (taskRouter?.server) await taskRouter.stop();
    await evaluator.close();
    const drained = new Promise((resolve) => {
      log.once("finish", resolve);
      log.once("close", resolve);
      log.end();
    });
    await Promise.race([
      drained,
      new Promise((resolve) => {
        const timer = setTimeout(resolve, 1000);
        timer.unref();
      }),
    ]);
    rmSync(socketDir, { recursive: true, force: true });
  }
}
