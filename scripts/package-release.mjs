#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const verified = {
  codex: "accacf313385c7c20901162af3049a3a6d53428e2df3ebed3759450f327ec05d",
  helper: "b33e8a5283f3c65c2a0aca6d43a59cfe850f624d8fa16992e3cad4fcc27c14e1",
};
const exactFiles = [
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "README.md",
  "README.zh-CN.md",
  "ci/README.md",
  "ci/workflows/ci.yml",
  "ci/workflows/native-build.yml",
  "package.json",
  "package-lock.json",
  "config.example.json",
  "patches/LICENSE.codex",
  "patches/NOTICE.codex",
  "patches/native-checkpoint.patch",
  "patches/upstream.json",
  "scripts/build-codex.mjs",
  "scripts/package-release.mjs",
  "assets/readme/hero-4109511b346c.svg",
  "bin/ares.mjs",
  "bin/astra-ares.mjs",
  "docs/architecture.md",
  "docs/building.md",
  "docs/configuration.md",
  "docs/installation.md",
  "docs/paid-access.md",
  "docs/troubleshooting.md",
  "docs/validation.md",
  "profiles/ROOT_POLICY.md",
  "profiles/agents/command_reader.toml",
  "profiles/agents/executor.toml",
  "profiles/agents/executor_adaptive.toml",
  "profiles/agents/explorer.toml",
  "profiles/agents/luna_executor.toml",
  "profiles/agents/luna_worker.toml",
  "profiles/agents/researcher.toml",
  "profiles/agents/reviewer.toml",
  "profiles/agents/reviewer_core.toml",
  "profiles/agents/simple_worker.toml",
  "profiles/agents/simple_worker_adaptive.toml",
  "profiles/agents/tester.toml",
  "profiles/agents/worker.toml",
  "routing/README.md",
  "routing/jev_triage.py",
  "routing/pricing.json",
  "routing/select_model.py",
  "routing/test_select_model.py",
  "routing/typesafe_triage.py",
  "src/bridge.mjs",
  "src/cli-args.mjs",
  "src/config.mjs",
  "src/context-budget.mjs",
  "src/evaluator-worker.mjs",
  "src/isolated-evaluator.mjs",
  "src/jev.mjs",
  "src/launch.mjs",
  "src/luna-summary.mjs",
  "src/provider-error.mjs",
  "src/task-router.mjs",
  "src/tool-output-budget.mjs",
];
const groups = [
  ["bin", new Set([".mjs"])],
  ["src", new Set([".mjs"])],
  ["docs", new Set([".md"])],
  ["profiles/agents", new Set([".toml"])],
  ["routing", new Set([".py", ".json", ".md"])],
  ["assets/readme", new Set([".svg", ".png", ".webp", ".jpg"])],
];
const hash = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const inside = (path, parent) => {
  const pathFromParent = relative(parent, path);
  return (
    pathFromParent === "" ||
    (pathFromParent !== ".." &&
      !pathFromParent.startsWith(
        `..${process.platform === "win32" ? "\\" : "/"}`,
      ) &&
      !isAbsolute(pathFromParent))
  );
};

export function releaseFiles(source = root) {
  const files = new Set(exactFiles);
  for (const [directory, extensions] of groups) {
    const base = join(source, directory);
    if (!lstatSync(base).isDirectory())
      throw new Error(`Expected directory: ${directory}`);
    for (const item of readdirSync(base, { withFileTypes: true })) {
      if (item.name.startsWith(".")) continue;
      const extension = item.name.slice(item.name.lastIndexOf("."));
      if (!extensions.has(extension)) continue;
      if (!item.isFile())
        throw new Error(
          `Refusing non-file release entry: ${directory}/${item.name}`,
        );
      if (!files.has(`${directory}/${item.name}`))
        throw new Error(`Review new release file: ${directory}/${item.name}`);
    }
  }
  for (const file of files)
    if (!lstatSync(join(source, file)).isFile())
      throw new Error(`Refusing non-file release entry: ${file}`);
  return [...files].sort();
}

export function packageRelease({ codex, helper, output }) {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error(
      "This verified binary release is only for Linux x86_64 GNU",
    );
  if (!codex || !helper || !output)
    throw new Error(
      "Usage: node scripts/package-release.mjs --codex PATH --helper PATH --output PATH.tar.gz",
    );
  if (!output.endsWith(".tar.gz"))
    throw new Error("Output must end in .tar.gz");
  const source = realpathSync(root);
  const destination = resolve(output);
  const outputParent = realpathSync(dirname(destination));
  if (inside(outputParent, source))
    throw new Error("Release output must be outside the source repository");
  if (
    existsSync(destination) ||
    lstatSync(destination, { throwIfNoEntry: false })
  )
    throw new Error("Release output already exists; choose a new destination");
  if (hash(codex) !== verified.codex)
    throw new Error("Codex checksum does not match the verified Linux build");
  if (hash(helper) !== verified.helper)
    throw new Error(
      "Companion checksum does not match pinned upstream 0.160.1",
    );
  const version = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ).version;
  const folder = `astra-ares-multi-agent-${version}-linux-x86_64-gnu`;
  if (basename(destination) !== `${folder}.tar.gz`)
    throw new Error(`Output filename must be ${folder}.tar.gz`);
  const temporary = mkdtempSync(join(outputParent, ".astra-ares-release-"));
  const stage = join(temporary, folder);
  try {
    const manifest = [];
    for (const file of releaseFiles()) {
      const target = join(stage, file);
      mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
      copyFileSync(join(root, file), target);
      chmodSync(target, file.startsWith("bin/") ? 0o755 : 0o644);
      manifest.push({ path: file, sha256: hash(target) });
    }
    for (const [name, path] of [
      ["codex", codex],
      ["codex-code-mode-host", helper],
    ]) {
      const file = `native/bin/${name}`;
      const target = join(stage, file);
      mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
      copyFileSync(path, target);
      chmodSync(target, 0o755);
      manifest.push({ path: file, sha256: hash(target) });
    }
    writeFileSync(
      join(stage, "release-manifest.json"),
      JSON.stringify(
        {
          name: "astra-ares-multi-agent",
          version,
          target: "x86_64-unknown-linux-gnu",
          codexVersion: "0.160.1",
          requiredLibraries: [
            "glibc >= 2.39",
            "libssl.so.3",
            "libcrypto.so.3",
            "libgcc_s.so.1",
          ],
          files: manifest.sort((a, b) => a.path.localeCompare(b.path)),
        },
        null,
        2,
      ) + "\n",
      { mode: 0o644 },
    );
    chmodSync(join(stage, "release-manifest.json"), 0o644);
    const normalizeDirectories = (directory) => {
      chmodSync(directory, 0o755);
      for (const entry of readdirSync(directory, { withFileTypes: true }))
        if (entry.isDirectory())
          normalizeDirectories(join(directory, entry.name));
    };
    normalizeDirectories(stage);
    execFileSync(
      "tar",
      [
        "--sort=name",
        "--mtime=@0",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "-czf",
        destination,
        "-C",
        temporary,
        folder,
      ],
      {
        env: { ...process.env, TAR_OPTIONS: "" },
      },
    );
    chmodSync(destination, 0o644);
    writeFileSync(
      `${destination}.sha256`,
      `${hash(destination)}  ${basename(destination)}\n`,
      { mode: 0o644 },
    );
    chmodSync(`${destination}.sha256`, 0o644);
    return destination;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const options = {};
    for (let i = 2; i < process.argv.length; i += 2) {
      const key = process.argv[i];
      const value = process.argv[i + 1];
      if (
        !["--codex", "--helper", "--output"].includes(key) ||
        !value ||
        value.startsWith("--")
      )
        throw new Error(
          "Expected --codex PATH --helper PATH --output PATH.tar.gz",
        );
      options[key.slice(2)] = value;
    }
    console.log(packageRelease(options));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
