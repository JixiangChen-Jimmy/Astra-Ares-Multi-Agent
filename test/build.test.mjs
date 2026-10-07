import { test } from "node:test";
import assert from "node:assert/strict";
import { nativeBuildEnv, nativeTargets } from "../scripts/build-codex.mjs";
import { releaseFiles } from "../scripts/package-release.mjs";

test("macOS builds preserve proc-macro symbols even with inherited stripping enabled", () => {
  const inherited = {
    PATH: "/example/bin",
    RUSTUP_TOOLCHAIN: "1.95.0",
    CARGO_INCREMENTAL: "1",
    CARGO_PROFILE_DEV_SMALL_STRIP: "symbols",
  };
  const build = nativeBuildEnv(inherited, "darwin");
  assert.equal(build.CARGO_PROFILE_DEV_SMALL_STRIP, "none");
  assert.equal(build.CARGO_INCREMENTAL, "0");
  assert.equal(build.PATH, inherited.PATH);
  assert.equal(build.RUSTUP_TOOLCHAIN, inherited.RUSTUP_TOOLCHAIN);
  assert.equal(inherited.CARGO_PROFILE_DEV_SMALL_STRIP, "symbols");
  assert.equal(inherited.CARGO_INCREMENTAL, "1");
});

test("Linux retains its existing Cargo profile and explicit strip setting", () => {
  assert.deepEqual(nativeBuildEnv({ PATH: "/example/bin" }, "linux"), {
    PATH: "/example/bin",
    CARGO_INCREMENTAL: "0",
  });
  assert.equal(
    nativeBuildEnv({ CARGO_PROFILE_DEV_SMALL_STRIP: "debuginfo" }, "linux")
      .CARGO_PROFILE_DEV_SMALL_STRIP,
    "debuginfo",
  );
});

test("Linux build target and official companion target are distinguished", () => {
  assert.deepEqual(nativeTargets("linux", "x64"), {
    build: "x86_64-unknown-linux-gnu",
    helper: "x86_64-unknown-linux-musl",
  });
  assert.deepEqual(nativeTargets("darwin", "arm64"), {
    build: "aarch64-apple-darwin",
    helper: "aarch64-apple-darwin",
  });
  assert.throws(
    () => nativeTargets("win32", "x64"),
    /Unsupported native build target/,
  );
});

test("release source list contains runtime, profiles and attribution without private state", () => {
  const files = releaseFiles();
  for (const required of [
    "bin/ares.mjs",
    "src/launch.mjs",
    "routing/select_model.py",
    "profiles/ROOT_POLICY.md",
    "README.zh-CN.md",
    "patches/LICENSE.codex",
    "patches/NOTICE.codex",
  ])
    assert.ok(files.includes(required), required);
  assert.ok(
    files.every(
      (file) => !file.startsWith("work/") && !file.includes("auth.json"),
    ),
  );
});
