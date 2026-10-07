import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve, join, dirname } from "node:path";

export function locations(env = process.env) {
  const home = env.ARES_HOME
    ? resolve(env.ARES_HOME)
    : join(homedir(), ".local/share/astra-ares-multi-agent");
  const config = env.ARES_CONFIG
    ? resolve(env.ARES_CONFIG)
    : join(
        env.XDG_CONFIG_HOME || join(homedir(), ".config"),
        "astra-ares-multi-agent/config.json",
      );
  return {
    home,
    config,
    binary: join(home, "bin/codex"),
    codexHome: join(home, "codex-home"),
    runs: join(home, "runs"),
  };
}
export function validateConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Config must be a JSON object");
  const allowed = [
    "provider",
    "apiKey",
    "apiKeyEnv",
    "apiKeyFile",
    "maxLeaseSteps",
    "codexHome",
    "codexBinary",
    "lunaSummary",
    "summaryCodexBinary",
    "summaryCodexHome",
    "summaryMaxAttempts",
    "taskRouting",
    "taskRouterScript",
    "mode",
    "routeProvider",
    "routeApiKey",
    "routeApiKeyEnv",
    "routeApiKeyFile",
  ];
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new Error(`Unknown config field: ${key}`);
  if (!["vercel", "typesafe", "openrouter"].includes(value.provider))
    throw new Error("provider must be vercel, typesafe or openrouter");
  if (![1, 2, 5].includes(value.maxLeaseSteps ?? 5))
    throw new Error("maxLeaseSteps must be 1, 2 or 5");
  if (
    value.mode !== undefined &&
    !["adaptive", "multi-agent"].includes(value.mode)
  )
    throw new Error("mode must be adaptive or multi-agent");
  if (
    value.routeProvider !== undefined &&
    !["typesafe", "zen"].includes(value.routeProvider)
  )
    throw new Error("routeProvider must be typesafe or zen");
  if (value.lunaSummary !== undefined && typeof value.lunaSummary !== "boolean")
    throw new Error("lunaSummary must be a boolean");
  if (value.taskRouting !== undefined && typeof value.taskRouting !== "boolean")
    throw new Error("taskRouting must be a boolean");
  if (value.taskRouting === true && value.mode === "adaptive")
    throw new Error("taskRouting conflicts with adaptive mode");
  if (
    value.summaryMaxAttempts !== undefined &&
    ![1, 2, 3].includes(value.summaryMaxAttempts)
  )
    throw new Error(
      "summaryMaxAttempts must be 1, 2 or 3 (including the first attempt)",
    );
  for (const key of allowed.filter(
    (k) =>
      ![
        "maxLeaseSteps",
        "lunaSummary",
        "summaryMaxAttempts",
        "taskRouting",
      ].includes(k),
  )) {
    if (
      value[key] !== undefined &&
      (typeof value[key] !== "string" || !value[key].trim())
    )
      throw new Error(`${key} must be a nonempty string`);
  }
  if (
    ["apiKey", "apiKeyEnv", "apiKeyFile"].filter(
      (key) => value[key] !== undefined,
    ).length > 1
  )
    throw new Error("Choose one of apiKey, apiKeyEnv or apiKeyFile");
  if (
    ["routeApiKey", "routeApiKeyEnv", "routeApiKeyFile"].filter(
      (key) => value[key] !== undefined,
    ).length > 1
  )
    throw new Error(
      "Choose one of routeApiKey, routeApiKeyEnv or routeApiKeyFile",
    );
  for (const key of [
    "codexHome",
    "codexBinary",
    "apiKeyFile",
    "routeApiKeyFile",
    "summaryCodexBinary",
    "summaryCodexHome",
    "taskRouterScript",
  ])
    if (value[key] && !value[key].startsWith("/"))
      throw new Error(`${key} must be an absolute path`);
  return {
    ...value,
    mode: value.mode ?? (value.taskRouting ? "multi-agent" : "adaptive"),
    maxLeaseSteps: value.maxLeaseSteps ?? 5,
  };
}
export function readRouteKey(config, env = process.env) {
  const provider =
    config.routeProvider ??
    (config.provider === "typesafe" ? "typesafe" : null);
  if (!provider)
    throw new Error(
      "Multi-agent routing needs routeProvider (typesafe or zen) and its own credential",
    );
  const variable =
    config.routeApiKeyEnv ??
    (provider === "typesafe" ? "TYPESAFE_API_KEY" : "ZEN_API_KEY");
  const key = config.routeApiKeyFile
    ? readFileSync(config.routeApiKeyFile, "utf8").trim()
    : config.routeApiKey?.trim() ||
      (provider === config.provider && !config.routeApiKeyEnv
        ? readKey(config, env)
        : env[variable]?.trim());
  if (!key || /\s/.test(key))
    throw new Error(
      `Missing or invalid ${provider} task-routing credential. Set ${variable} or routeApiKey in ${config.paths?.config ?? "config.json"}`,
    );
  return { provider, key };
}
export function loadConfig(env = process.env) {
  const paths = locations(env);
  if (!existsSync(paths.config))
    throw new Error(`Run ares setup first. Missing config: ${paths.config}`);
  return { ...readConfig(paths.config), paths };
}
export function readConfig(file) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`Cannot read valid JSON configuration: ${file}`);
  }
  return validateConfig(data);
}
export function readKey(config, env = process.env) {
  const variable =
    config.apiKeyEnv ||
    {
      vercel: "AI_GATEWAY_API_KEY",
      typesafe: "TYPESAFE_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
    }[config.provider];
  const key = config.apiKeyFile
    ? readFileSync(config.apiKeyFile, "utf8").trim()
    : config.apiKey?.trim() || env[variable]?.trim();
  if (!key || /\s/.test(key))
    throw new Error(
      `Missing or invalid Jev credential. Set ${variable} or apiKey in ${config.paths?.config ?? "config.json"}`,
    );
  return key;
}
export function saveConfig(file, config) {
  validateConfig(config);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.new`;
  writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}
