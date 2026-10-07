# Native build and release archive

`node bin/ares.mjs setup` builds Codex 0.160.1 from the pinned upstream commit and patch in `patches/upstream.json`. The builder checks the patch and source archive SHA-256 values before applying the patch. Cargo uses the upstream `codex-rs/rust-toolchain.toml` pin for Rust 1.95.0 and `--locked` dependencies. The code-mode helper comes from the exact upstream release archive and is checksum checked. On Linux, the CLI build is GNU/glibc; the official helper archive is labeled musl. Those are separate executables.

Install Node.js 22+, rustup with toolchain 1.95.0, Git, curl, tar, a C/C++ compiler, CMake, and pkg-config. Linux needs the OpenSSL 3 runtime and development package. For example, on Ubuntu or Debian, the native packages include `build-essential cmake pkg-config libssl-dev`. On macOS, install Xcode Command Line Tools. The builder checks these tools before downloading or compiling. Native builds need substantial disk space and time; the verified Linux binary archive avoids compilation on a matching host. The pinned `codex-cli` target uses the official separate code-mode helper; a full-workspace build additionally compiles code-mode host and its V8 sandbox dependency.

To create the shareable Linux archive from the accepted local binaries, run from this repository after final tests:

```sh
node scripts/package-release.mjs \
  --codex /absolute/path/to/verified/codex \
  --helper /absolute/path/to/verified/codex-code-mode-host \
  --output /outside/the/repo/astra-ares-multi-agent-0.3.0-linux-x86_64-gnu.tar.gz
```

The command only accepts the verified binary hashes recorded in the script: Codex `accacf313385c7c20901162af3049a3a6d53428e2df3ebed3759450f327ec05d` and helper `b33e8a5283f3c65c2a0aca6d43a59cfe850f624d8fa16992e3cad4fcc27c14e1`. It writes an archive, a `.sha256` sidecar, and an internal `release-manifest.json` with hashes of every file. The archive includes runtime JavaScript, routing scripts, profiles, metadata, and MIT/Apache notices. It excludes local credentials, sessions, test logs, caches, and build trees. Keep release artifacts outside the source repository.

This archive is accepted for Linux x86_64 GNU with glibc 2.39 or newer only. A new macOS or Linux ARM archive requires its own build, helper verification, native fixture checks, and platform label; changing the filename is insufficient.

The supplied native executable is the unchanged, locally verified build. Compiler diagnostic strings may retain source build paths; no runtime profile, credentials or chat transcripts are packaged. Rebuilding with compiler path remapping is appropriate if your distribution policy requires removing all build-path metadata.
