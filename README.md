# TML — Time Mini Launcher

A self-contained Minecraft: Java Edition launcher for Linux. `npm start` runs a
local server with a browser UI at `http://127.0.0.1:8620` and a full JSON API
under `/api`. Zero dependencies — Node.js built-ins only, no build step,
English-only interface.

Covers Microsoft sign-in, Vanilla and Fabric instances, Modrinth mods /
resource packs / shader packs, Java runtime downloads, instance export/import,
and an optional local game server per instance.

> Not affiliated with Mojang Studios or Microsoft. Minecraft is a trademark of
> Mojang Synergies AB.

## Run

```bash
npm start
```

The launcher prints its URL; open it in a browser. `Ctrl+C` stops the server
(5-second graceful shutdown).

State lives in `~/.tml-launcher` — instances, logs, cache, exports,
`config.json`, and the account session (`auth-session.json`, mode `0600`).
`TML_DATA_DIR` moves the whole directory.

```bash
npm test
```

## Requirements

| | |
| --- | --- |
| OS | Linux (the process refuses to start elsewhere) |
| Node.js | ≥ 18.17 (built-in modules only) |
| Network | For version metadata, downloads, Modrinth and sign-in (see below) |

## Configuration

Precedence: **built-in defaults < `$TML_DATA_DIR/config.json` < environment
variables.** Env values cannot be overridden from `config.json` (the API answers
`409 CONFIG_FROM_ENV`). Invalid values (port out of range, unknown log level,
malformed JSON, non-GUID client ID) fail startup immediately with `ConfigError`.

| Environment variable | Default | Description |
| --- | --- | --- |
| `TML_HOST` | `127.0.0.1` | Bind address |
| `TML_PORT` | `8620` | HTTP port |
| `TML_LOG_LEVEL` | `warn` | `debug` \| `info` \| `warn` \| `error` \| `silent` |
| `TML_DATA_DIR` | `~/.tml-launcher` | Data directory |
| `TML_MSA_CLIENT_ID` | built-in value | Microsoft Entra (Azure) application client ID (GUID) |

`config.json` example and keys:

```json
{
  "server": { "host": "127.0.0.1", "port": 8620 },
  "log": { "level": "warn" }
}
```

| Key | Effect |
| --- | --- |
| `server.host`, `server.port` | Bind address — requires a restart |
| `log.level` | Applied immediately (also editable in the UI) |
| `auth.clientId` | Overrides `TML_MSA_CLIENT_ID` |
| `auth.offlineName` | Player name used when no Microsoft session exists |
| `java.runtime` | Selected runtime name, or omitted for automatic selection |

## HTTP API

All endpoints live under `/api`:

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Status, version, uptime, platform |
| `GET` / `PATCH` | `/api/config` | Read / update `config.json` |
| `GET` / `POST` | `/api/instances` | List / create instances |
| `GET` / `PATCH` / `DELETE` | `/api/instances/:id` | Read / update / delete an instance |
| `POST` | `/api/instances/:id/launch` | Launch (progress via `launch-progress`) |
| `POST` | `/api/instances/:id/stop` | Stop a running instance |
| `GET` | `/api/instances/:id/launch-progress` | Launch progress (stage + percent) |
| `POST` | `/api/instances/:id/export` | Export to `.zip` |
| `POST` | `/api/instances/import` | Import from `.zip` |
| `GET` / `POST` / `DELETE` | `/api/instances/:id/mods[/:modId]` | List / install / remove mods |
| `GET` / `POST` / `DELETE` | `/api/instances/:id/packs[/:fileId]` | List / install / remove packs & shaders |
| `GET` | `/api/minecraft/versions[/:id]` | Minecraft version catalog |
| `GET` | `/api/minecraft/manifest` | Asset / libraries manifest |
| `GET` | `/api/fabric/loaders` | Fabric loader versions |
| `GET` | `/api/modrinth/search` | Search mods / packs on Modrinth |
| `GET` | `/api/modrinth/project/:id[...]` | Project details and versions |
| `POST` | `/api/auth/device` | Start device-code sign-in |
| `POST` | `/api/auth/login` | Wait for approval / complete sign-in |
| `GET` / `DELETE` | `/api/auth/session` | Masked session info / sign out |
| `GET` | `/api/java/runtimes` | List Microsoft OpenJDK runtimes |
| `POST` | `/api/java/runtimes/:name/download` | Download a runtime (SHA-1 verified) |
| `GET` | `/api/java/runtimes/:name/progress` | Download progress |
| `DELETE` | `/api/java/runtimes/:name` | Delete a downloaded runtime |
| `GET` / `POST` / `DELETE` | `/api/minecraft/skin[...]` | Current skin (masked) / upload / reset |
| `GET` | `/api/sources` | The network allowlist as JSON (`version`, `rules`, `sources`) — see Network access |
| `GET` | `/api/routes` | Route table (every method + path the API serves) |

Errors are `4xx/5xx` with a machine-readable `code` field (for example
`INVALID_LOG_LEVEL`, `INSTANCE_RUNNING`, `JAVA_RUNTIME_UNAVAILABLE`).

## Network access

Every remote host TML may reach is fixed by the allowlist in
`src/security/urls.js` — anything else is rejected with `SOURCE_NOT_ALLOWED`,
and each group is contacted only when its feature runs. The UI itself talks
only to `127.0.0.1` (its one remote image source is Modrinth icons, pinned by
the page's `Content-Security-Policy`). There is no telemetry or analytics of
any kind.

`GET /api/sources` serves this allowlist as JSON so you can see what TML may
reach without reading the source — that is why the endpoint exists, and why
the **Settings → Network access** card can render it live:

```json
{
  "version": "0.1.1",
  "rules": {
    "protocols": ["http:", "https:"],
    "defaultPortOnly": true,
    "credentialsNotAllowed": true,
    "categoryScoped": true
  },
  "sources": [
    { "id": "minecraft", "label": "Official Minecraft / Mojang",
      "hosts": ["piston-meta.mojang.com", "…"] }
  ]
}
```

`rules` states the constraints enforced alongside the host list: only
`http:`/`https:`, default ports only, no credentials embedded in URLs, and
each group scoped to its own source.

| Group | Hosts | Used for |
| --- | --- | --- |
| Microsoft / Xbox | `login.microsoftonline.com`, `user.auth.xboxlive.com`, `xsts.auth.xboxlive.com`, `api.minecraftservices.com` | Device-code sign-in, Xbox/XSTS steps, Minecraft session, profile and skin upload |
| Minecraft (Mojang) | `piston-meta.mojang.com`, `launchermeta.mojang.com`, `piston-data.mojang.com`, `launcher.mojang.com`, `resources.download.minecraft.net`, `libraries.minecraft.net` | Version manifests, assets, libraries, Java runtimes, logging config, game and server files |
| Fabric | `meta.fabricmc.net`, `maven.fabricmc.net` | Loader versions, installer and profile jars |
| Modrinth | `api.modrinth.com`, `cdn.modrinth.com` | Mod / pack search; icons shown in the UI |

Also:

- `microsoft.com/link` — never fetched by TML; when you start signing in, the
  UI opens it in **a new TML window** (never an external browser) and copies
  the user code to your clipboard — Microsoft's page does not accept a code in
  the URL (it returns no `verification_uri_complete`), so paste it there.
  Clicking the link in the modal works as a fallback.
- `textures.minecraft.net` — never contacted; skins are read from the local
  cache only.
- `account.mojang.com` — never contacted; appears only as a comment inside a
  generated `eula.txt`.
- The running game (and any game server you start) opens its own connections,
  as any Minecraft client does.

## Platform notes

- **Linux only.** `assertLinuxPlatform()` exits on any other OS.
- **Wayland only.** The game always launches with a Wayland-only environment
  (`DISPLAY` is removed so it cannot fall back to XWayland), and the TML window
  itself is Wayland-only (`run-tml.sh` refuses to start without
  `WAYLAND_DISPLAY`). On GNOME, Wayland windows get no server-side decorations —
  the game draws its own title bar.
- **Microsoft client ID.** The default is a public Azure application
  identifier, not a secret; replace it with `TML_MSA_CLIENT_ID` if preferred.
- **Credentials.** `auth-session.json` is stored with mode `0600`; tokens are
  redacted from logs and never exported.

## License

[GPL-3.0-or-later](LICENSE) © Time And Time Studio
