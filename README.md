# TML — Time Mini Launcher

**TML** is a self-contained Minecraft: Java Edition launcher for Linux. It runs as a small local server with a browser-based interface — install it from npm, run `tml`, and open the printed URL.

- **Zero runtime dependencies** — Node.js built-ins only, no build step, nothing to compile
- **Local web UI** — dark, English-only interface served from `http://127.0.0.1:8620`
- **Full HTTP API** — every feature in the UI is available as a JSON endpoint

> Not affiliated with Mojang Studios or Microsoft. Minecraft is a trademark of Mojang Synergies AB.

## Features

**Instance management**
- Create, import, and export instances as portable `.zip` archives (manifest + secret scan; no tokens ever exported)
- Isolated game directories per instance; instance names, memory limits (min–max MB), and extra JVM arguments are configurable
- One-click **PLAY / STOP** with a launch progress overlay and live status polling every 3 seconds
- Per-instance play time tracking (`Play time`, `Last played`)

**Versions, mods, and packs**
- Browse Minecraft releases and Fabric loader versions from official metadata
- Search Modrinth and install **mods**, **resource packs**, and **shader packs** directly into an instance (icons included; empty query shows popular items)
- Vanilla and Fabric (instance creation installs Fabric automatically)

**Accounts**
- Microsoft account sign-in via OAuth 2.0 device-code flow (Standard and Instant variants)
- Session persisted with `0600` permissions; tokens are redacted from logs and never leave the machine
- Offline mode fallback with a configurable player name

**Java runtimes**
- List, download, select, and delete Microsoft OpenJDK runtime builds (per-file SHA-1 verification)
- Automatic download when the selected runtime is missing at launch time
- PLAY is blocked with a clear error until a compatible downloaded runtime is selected

**Local API and UI**
- REST API bound to `127.0.0.1` by default (host/port configurable)
- Settings page edits `config.json` live: host, port, log level, game window platform (`auto` / `x11`), offline name
- View and manage existing instances: browse `mods`, `config`, `saves`, `resourcepacks`, `shaderpacks` and remove entries

## Requirements

| | |
| --- | --- |
| OS | Linux (the process refuses to start elsewhere) |
| Node.js | ≥ 18.17 (uses only Node built-in modules) |
| Browser | Any modern browser on the same machine |
| Network | Required for version manifests, Fabric metadata, Modrinth, Microsoft sign-in, and runtime downloads |

## Installation

```bash
npm install --global tml-launcher
```

Run from a clone (no dependencies to install, no build step):

```bash
npm test        # run the test suite first
npm start       # same as `tml`
```

## Usage

```bash
tml                 # start the launcher server and print the URL
tml --help, -h      # show command-line help
tml --version, -v   # print the installed version
```

On start, TML prints the address to open in a browser:

```
  TML — Time Mini Launcher
  http://127.0.0.1:8620
```

Stop the server with `Ctrl+C` (graceful shutdown with a 5-second guard).

> **Data directory:** by default, all state is stored in `./tml-data` **relative to the directory where you run `tml`** (instances, logs, cache, exports, `config.json`, account session). When installing globally, either run `tml` from a dedicated working directory or set `TML_DATA_DIR` explicitly.

## Configuration

Precedence: **built-in defaults < `tml-data/config.json` < environment variables.**

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `TML_HOST` | `127.0.0.1` | Bind address |
| `TML_PORT` | `8620` | HTTP port |
| `TML_LOG_LEVEL` | `warn` | `debug` \| `info` \| `warn` \| `error` \| `silent` |
| `TML_DATA_DIR` | `<cwd>/tml-data` | Data directory (instances, logs, config) |
| `TML_MSA_CLIENT_ID` | built-in value | Microsoft Entra (Azure) application client ID (GUID) |

Values taken from the environment cannot be overridden from `config.json` (the API answers `409 CONFIG_FROM_ENV`).

### `config.json`

Located at `$TML_DATA_DIR/config.json`. Example:

```json
{
  "server": { "host": "127.0.0.1", "port": 8620 },
  "log": { "level": "warn" },
  "window": { "platform": "auto" }
}
```

| Key | Effect |
| --- | --- |
| `server.host`, `server.port` | Bind address — requires a restart |
| `log.level` | Applied immediately (also editable in the UI) |
| `window.platform` | `auto` (system default) or `x11` (XWayland) — applies to the next launch |
| `auth.clientId` | Overrides `TML_MSA_CLIENT_ID` |
| `auth.offlineName` | Player name used when no Microsoft session exists |
| `java.runtime` | Selected runtime name, or omitted for automatic selection |

Invalid values (port out of range, unknown log level, malformed JSON, non-GUID client ID) cause startup to fail immediately with a `ConfigError`.

## HTTP API

All endpoints are served under `/api`. Summary:

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Status, version, uptime, platform |
| `GET` / `PATCH` | `/api/config` | Read / update `config.json` |
| `GET` / `POST` | `/api/instances` | List / create instances |
| `GET` / `PATCH` / `DELETE` | `/api/instances/:id` | Read / update / delete an instance |
| `POST` | `/api/instances/:id/launch` | Launch (returns progress via `launch-progress`) |
| `POST` | `/api/instances/:id/stop` | Stop a running instance |
| `GET` | `/api/instances/:id/launch-progress` | Launch progress (stage + percent) |
| `POST` | `/api/instances/:id/export` | Export to `.zip` |
| `POST` | `/api/instances/import` | Import from `.zip` |
| `GET` / `POST` / `DELETE` | `/api/instances/:id/mods[/:modId]` | List / install / remove mods |
| `GET` / `POST` / `DELETE` | `/api/instances/:id/packs[/:fileId]` | List / install / remove resource packs & shaders |
| `GET` | `/api/minecraft/versions[/:id]` | Minecraft version catalog |
| `GET` | `/api/minecraft/manifest` | Asset/libraries manifest |
| `GET` | `/api/fabric/loaders` | Fabric loader versions |
| `GET` | `/api/modrinth/search` | Search mods / packs on Modrinth |
| `GET` | `/api/modrinth/project/:id[...]` | Project details and versions |
| `POST` | `/api/auth/device` | Start device-code sign-in |
| `POST` | `/api/auth/login` | Wait for approval / complete sign-in |
| `POST` | `/api/auth/refresh` | Refresh the session token |
| `GET` / `DELETE` | `/api/auth/session` | Masked session info / sign out |
| `GET` | `/api/java/runtimes` | List Microsoft OpenJDK runtimes |
| `POST` | `/api/java/runtimes/:name/download` | Download a runtime (SHA-1 verified) |
| `GET` | `/api/java/runtimes/:name/progress` | Download progress |
| `DELETE` | `/api/java/runtimes/:name` | Delete a downloaded runtime |
| `GET` / `POST` / `DELETE` | `/api/minecraft/skin[...]` | Current skin (masked) / upload / reset |
| `GET` | `/api/routes`, `/api/sources` | Route table and data-source introspection |

Error responses use `4xx/5xx` with a machine-readable `code` field (for example `INVALID_LOG_LEVEL`, `INSTANCE_RUNNING`, `JAVA_RUNTIME_UNAVAILABLE`).

## Development

```bash
npm test        # node --test — 402 tests (unit + API + workflow)
npm run dev     # restart on file changes (node --watch)
```

Project layout:

```
src/
  core/        config, logger, filesystem, platform
  server/      HTTP server, static files, API router
  instance/    instance manager, validation, export/import
  minecraft/   version metadata, installer, launcher
  fabric/      Fabric installer and metadata API
  modrinth/    Modrinth search and versions
  mods/        mod/pack installers and registry
  java/        Java runtime discovery, download, selection
  auth/        Microsoft device-code flow, token store
  archive/     zip reader/writer
web/           static UI (index.html, css, js)
tests/         node:test suites
```

Conventions: ES modules (`"type": "module"`), no third-party packages, English-only UI strings, Thai/English code comments as written.

## Platform notes

- **Linux only.** The launcher calls `assertLinuxPlatform()` and exits on any other OS.
- **Game window platform.** SDL video output can be pinned to X11 (XWayland) or left to the system default from **Settings → Launcher** so the window decorations match the desktop theme; the choice applies to the next launch.
- **Microsoft client ID.** Ships with a default public client ID (an Azure application identifier, not a secret). Replace it with your own via `TML_MSA_CLIENT_ID` if preferred.
- **Credentials.** The account session is stored at `$TML_DATA_DIR/auth-session.json` with mode `0600`. Tokens are redacted from logs and excluded from exports.

## License

[GPL-3.0-or-later](LICENSE) © Time And Time Studio
