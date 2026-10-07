// Value-taking root options in the pinned Codex CLI (utils/cli + tui/cli).
// This only guards unsupported transports; Codex still validates the arguments.
const valueOptions = new Set([
  "-c",
  "--config",
  "--enable",
  "--disable",
  "-i",
  "--image",
  "-m",
  "--model",
  "--local-provider",
  "-p",
  "--profile",
  "-s",
  "--sandbox",
  "-a",
  "--ask-for-approval",
  "-C",
  "--cd",
  "--add-dir",
  "--remote-auth-token-env",
]);
const unsupported = new Set(["agents", "remote-control", "app", "update"]);
const localSubcommands = new Set([
  "exec",
  "e",
  "review",
  "login",
  "logout",
  "mcp",
  "plugin",
  "app-server",
  "completion",
  "doctor",
  "sandbox",
  "debug",
  "execpolicy",
  "apply",
  "a",
  "cloud",
  "cloud-tasks",
  "features",
  "help",
  "migrate-rollouts",
  "responses-api-proxy",
  "stdio-to-uds",
]);
const error =
  "Use local CLI sessions. Daemon/remote/app transport and stock self-update are not supported by this checkpoint.";

export function assertLocalCliArgs(args) {
  let command;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return;
    if (arg === "--remote" || arg.startsWith("--remote="))
      throw new Error(error);
    const imageOption =
      arg === "-i" ||
      arg === "--image" ||
      arg.startsWith("--image=") ||
      (arg.startsWith("-i") && !arg.startsWith("--"));
    if (imageOption) {
      if (arg === "-i" || arg === "--image") i++;
      while (i + 1 < args.length && !args[i + 1].startsWith("-")) i++;
      continue;
    }
    if (valueOptions.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    if (command === undefined) {
      command = arg;
      if (unsupported.has(command)) throw new Error(error);
      // Local subcommands own their flags, values and positional prompts.
      // Interactive prompts and resume/fork/attach can have remote flags after them.
      if (localSubcommands.has(command)) return;
    }
  }
}
