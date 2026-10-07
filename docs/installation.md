# Installation

Astra Ares Multi Agent needs Node.js 22 or newer. Its two modes use a patched Codex CLI; a stock Codex binary cannot provide the native checkpoints. Python 3 is required for the optional task routing scripts.

## Linux x86_64 archive

The locally verified archive is for Linux x86_64 with glibc 2.39 or newer, OpenSSL 3 (`libssl.so.3` and `libcrypto.so.3`), and `libgcc_s.so.1`. This minimum is derived from the binary's versioned glibc symbols; it does not establish compatibility with every distribution meeting that version. The archive includes the patched Codex 0.160.1 binary and its companion. Keep the extracted directory in place after setup because configuration records the binary's absolute path.

```sh
sha256sum -c astra-ares-multi-agent-0.3.0-linux-x86_64-gnu.tar.gz.sha256
tar -xzf astra-ares-multi-agent-0.3.0-linux-x86_64-gnu.tar.gz
cd astra-ares-multi-agent-0.3.0-linux-x86_64-gnu
npm ci --omit=dev
node bin/ares.mjs setup --binary "$PWD/native/bin/codex"
npm link
ares configure
ares doctor
```

`npm ci` downloads the pinned JavaScript dependency. The archive does not include credentials, sessions, logs, or a Node.js runtime. `ares configure` adds the selected provider key; setup itself does not require one. An environment variable can supply the key instead; see the configuration guide.

Without `npm link`, use `node bin/ares.mjs` and `node bin/astra-ares.mjs` from the extracted directory. See the main README for mode selection and launch commands.

## Source checkout

Run these commands from a checkout of this repository:

```sh
npm ci
node bin/ares.mjs setup
npm link
ares configure
```

Source setup downloads the SHA-256 pinned Codex source archive and matching official code-mode helper, applies the checked patch, and compiles a separate CLI. It needs Rust 1.95.0 through rustup, Git, curl, tar, C/C++ tools, CMake, and pkg-config. Linux also needs OpenSSL development files. Budget at least 10 GB of temporary build space. On macOS install Xcode Command Line Tools; macOS source builds have not been accepted on this new release. Windows is unsupported. See [building.md](building.md) for details.

An existing compatible binary can be adopted with `ares setup --binary /absolute/path/to/codex`; its `codex-code-mode-host` companion must be beside it. Setup verifies the checkpoint and version before saving the path.

## Local state and removal

This project uses `~/.config/astra-ares-multi-agent` and `~/.local/share/astra-ares-multi-agent` by default. These directories hold credentials, config, builds, and session data. The older `astra-ares` and `ct-agent-orchestration` directories are separate. `npm unlink -g astra-ares-multi-agent` removes linked commands but retains local state. Remove the state directories only after inspecting anything you want to keep.
