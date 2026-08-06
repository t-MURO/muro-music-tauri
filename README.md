# Muro Music (Tauri)

Muro Music is a customizable desktop music library and player. This edition uses Tauri 2: the React interface runs in the operating system's native WebView, while SQLite, playback, metadata, library management, analysis supervision, backups, Cast, and DLNA run in Rust. Electron, Chromium, and Node.js are not shipped with the installed app.

## Development

Requirements:

- Node.js 22.22 or newer (build tooling only)
- Rust stable and the platform's native build toolchain
- Windows: Visual Studio 2022 Desktop development with C++
- Linux: WebKitGTK development packages, ALSA, and OpenSSL

Install and run:

    npm ci
    npm run tauri:dev

Tauri development prepares checksum-verified KeyFinder and Chromaprint sidecars before starting. The installed app launches those native executables directly; Node is not a runtime dependency.

## Validation and packaging

    npm run check
    npm run check:rust
    npm run verify:release
    npm run tauri:build

npm run tauri:build creates the platform installer and bundles the verified analysis sidecars.

Pinned Neo KeyFinder 0.1.2 releases currently cover Windows x64 and macOS x64/ARM64. Chromaprint 1.6.0 also covers Linux x64/ARM64. Linux and Windows ARM64 packaging intentionally stop with a clear error until matching trusted KeyFinder artifacts and checksums are published; this prevents shipping an installer with silently missing analysis features.

## Architecture

- Native Rodio/Symphonia/CPAL playback with OS media controls
- Native SQLite library, playlists, history, search, backups, and metadata writes
- Native KeyFinder and Chromaprint supervision with Rust AcoustID requests
- Token-authorized local/LAN media servers for analysis and remote playback
- Native CastV2 and DLNA output services
- Strict Tauri capabilities and content security policy

Metadata conventions are documented in [docs/METADATA_SPECS.md](docs/METADATA_SPECS.md).