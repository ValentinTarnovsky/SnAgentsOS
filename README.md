<div align="center">

<img src="build/icon.png" width="104" alt="SnAgentsOS" />

# SnAgentsOS

**A personal command center for AI coding agents and terminals, on desktop and phone.**
Open *sets* of multiple terminals and AI CLI sessions (Claude Code, Codex, custom) in a draggable mosaic: a branded, multi-agent workspace from the `Sn` brand.

*Engineered in silence.*

[![CI](https://github.com/ValentinTarnovsky/SnAgentsOS/actions/workflows/ci.yml/badge.svg)](https://github.com/ValentinTarnovsky/SnAgentsOS/actions/workflows/ci.yml)
[![Release](https://github.com/ValentinTarnovsky/SnAgentsOS/actions/workflows/release.yml/badge.svg)](https://github.com/ValentinTarnovsky/SnAgentsOS/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-6366f1.svg)](./LICENSE)

</div>

![SnAgentsOS](docs/screenshot.png)

---

> **Status:** `v2.0.0`, stable. Upgrading from a 1.x version? Your data moves over by itself, see [Upgrading from 1.x](#upgrading-from-1x). Built in public as a VibeCoding showcase, open source under MIT.

## What it is

A collapsible sidebar lists **workspaces** (not chats). Opening a workspace shows a **tiling mosaic** of real shells (PowerShell on Windows, zsh/bash on macOS/Linux) and AI CLI panes. Each workspace remembers its directory, its panes, and its exact grid layout. Reusable **models** (agent presets) let you launch N sessions of Claude Code / Codex / any custom command in one click, and reusable **connection profiles** can SSH into a box and log in automatically before the model even starts.

## Features

- 🖥️ **Real terminals**: true PTYs via `node-pty` + `xterm.js`, GPU-accelerated (WebGL, with an automatic Canvas fallback so heavy AI-CLI redraws never glitch).
- 🧩 **Tiling mosaic**: a fixed, drag-to-reorder grid (1 to 12 panes). Maximize a pane, reorder by dragging its header, middle-click to close. Layout is saved per workspace.
- 🤖 **Models**: Shell / Claude Code / Codex out of the box. Define your own custom AI CLIs (command, args, env, default directory) in Settings.
- 🔌 **Connection profiles**: reusable pre-launch sequences (for example, SSH into a server). Each step waits for the console to print something (like `password:`) and then sends the next line, so a whole login flow runs automatically across every console in the workspace.
- 📁 **Per-workspace directory**: pick any folder, every console opens there.
- 🔎 **Built for long sessions**: infinite (or capped) scrollback, in-pane find, a command palette (`Ctrl/Cmd+K`), and saved prompt snippets.
- ⌨️ **Remappable keyboard shortcuts** and an optional global hotkey to summon the window from anywhere.
- 🎨 **Themes + i18n**: Midnight, Light, Nord, Dracula, Solarized and a fully custom palette. English and Spanish.
- 🪟 **Native feel**: frameless custom title bar, tray integration, launch on startup, crash-safe config with automatic backups.
- 📦 **Portable + installable**: Windows 10+, macOS (Intel + Apple Silicon), Linux.

## Agent status and notifications

Open **Settings > Notifications** to enable the integrations:

1. **Claude:** install or repair the status hooks, then restart the Claude session. Existing third-party hooks are preserved. Settings show whether hooks are complete and events have arrived.
2. **Codex:** enable the local integration and restart the console. Interactive `codex` commands use a private App Server for each console, preserving the shell environment and directory. Existing sessions keep their transport until they exit. Requires a native Codex executable in PATH supporting `app-server --stdio` and `--remote` (tested with 0.157.1).
3. **Discord:** enter a webhook URL and your Discord user ID, enable delivery, and use **Send test to Discord**. Leave the user ID empty for messages without a ping. Intervention/failure and turn-completion messages have separate switches. Discord works while the app is focused and independently of desktop notifications.

Use **Test desktop notification** to check the system channel. If Windows blocks it, enable SnAgentsOS under **Windows Settings > System > Notifications**. The app reports native delivery errors in its notification settings.

Console headers and both sidebar layouts show violet for working, amber for pending input, green for a completed turn, red for failure, gray for idle, and a hollow dot for lost status. Pending requests remain visible while an agent continues working. Sidebar counters include hidden consoles in the active workspace.

In the phone web client, vertical finger drags also scroll applications that capture the mouse, such as Claude. These gestures become terminal wheel events; regular shell scrollback, horizontal pan and taps to open the keyboard retain their usual behavior.

Integration limits: remote SSH/WSL sessions, explicit executable paths, `--remote`, and `--no-daemon` bypass the local Codex launcher. Initial login/trust dialogs and free-form questions may not emit structured events; completion notifications cover the end of those responses. Claude title fallback is approximate. Codex async message questions are acknowledged when the server accepts the next user input; individually identified RPC requests resolve separately.

Discord sends only provider, workspace/pane names, reason and time. Webhook URLs remain in the local config and its backups, are hidden in the UI, and are removed from config exports. No prompts, command output, or terminal contents are sent. A network timeout can leave delivery unconfirmed; the app reports it without blindly duplicating the message.

## Connection profiles (SSH and more)

Define a profile once in **Settings → Connections**, then pick it when you create a workspace and it applies to every console:

1. `send` &nbsp;`ssh root@your-server`
2. `wait` for `password:` &nbsp;then `send` your password (stored masked)
3. `wait` for the shell prompt &nbsp;then `send` `cd /your/path`
4. ... the model command (Claude Code, Codex, ...) runs once the sequence finishes.

Each step supports a fixed delay, a wait timeout (it proceeds anyway if the text never appears), a `secret` flag that masks the value in the UI, and substring or `/regex/` matching. The sequence runs in the main process, so it keeps going even if the UI reloads, and every console runs it independently (so N consoles all connect in parallel).

## Download

Grab the latest build from **[Releases](https://github.com/ValentinTarnovsky/SnAgentsOS/releases)**:

| Platform | Artifact |
|----------|----------|
| Windows (installer) | `SnAgentsOS-x.y.z-setup.exe` |
| Windows (portable) | `SnAgentsOS-x.y.z-portable.exe` (stores its config in `snagentsos-data` next to the `.exe`) |
| macOS | `SnAgentsOS-x.y.z.dmg` / `-mac.zip` (x64 + arm64) |
| Linux | `SnAgentsOS-x.y.z.AppImage` / `snagentsos_x.y.z_amd64.deb` |

Every file has a `.sha256` next to it, and the built-in updater refuses a download without one.

> CI builds all three platforms on every `v*` tag into a draft release and publishes it only once all 16 files are attached (see `.github/workflows/release.yml`).
> Builds are unsigned for now, so Windows SmartScreen / macOS Gatekeeper may warn on first launch.

<!-- legacy-start -->
<a name="upgrading-from-1x"></a>

## Formerly SnMultiCC (upgrading from 1.x)

Up to 1.14.1 this app was called **SnMultiCC**. Version 2.0.0 is the same app under a new name, and the upgrade is automatic: install it over 1.x (or let the 1.x updater do it) and there is nothing else to do.

**What happens on the first start**

1. SnAgentsOS copies your SnMultiCC data into its own folder: settings, workspaces, models, connection profiles, config backups and paired phones. It checks every file against the original (SHA-256 and a full config parse) before it trusts the copy.
2. It writes a safety backup, `migration-backup-v1.zip`, reopens it and checks it.
3. Only then does it delete what SnMultiCC left behind, in the background:
   - the old data folder (`%APPDATA%\snmulticc`, or `snmulticc-data` next to a portable `.exe`; `~/Library/Application Support/snmulticc` on macOS, `~/.config/snmulticc` on Linux) and `%APPDATA%\snmulticc-dev` if it exists;
   - the old install folder and its entry in **Settings > Apps** (the installer runs the old uninstaller), plus the Start menu and desktop shortcuts;
   - the launch-on-startup entry (registered again for SnAgentsOS first, if it was on) and the old notification registration;
   - the updater cache and temporary files, including the `%TEMP%\SnMultiCC` extraction of the 1.x portable;
   - the 1.x Claude Code hooks (rewritten to SnAgentsOS; hooks of other tools are left alone) and `~/.claude/settings.json.snmulticc.bak` (it goes into the zip first);
   - on the portable, the running `.exe` is renamed to `SnAgentsOS-portable.exe`, older `SnMultiCC-x.y.z-portable.exe` files next to it are deleted, and shortcuts that pointed to it are redirected.

A one-time notice lists what came over and shows the cleanup status. A file that is still in use is retried by itself (after a minute, every 5 minutes while the app is open, and on every start). If the copy fails, a banner says so, your SnMultiCC data stays untouched and the migration runs again on the next start. Every step is written to `logs/legacy-migration.log` in the data folder.

**The safety backup and recovery**

`migration-backup-v1.zip` lives in the SnAgentsOS data folder (`%APPDATA%\snagentsos` for the installed app, `snagentsos-data` next to the portable `.exe`, `~/Library/Application Support/snagentsos` on macOS, `~/.config/snagentsos` on Linux). **Settings > Data** shows its path and the date it goes away, with a **Show** button. It holds your 1.x files exactly as they were (`config.json`, `remote-devices.json`, `backups/`, the hooks backup) and is **deleted automatically 30 days after the migration**. It contains your phone pairing secrets, so do not share it.

It exists only for a disaster. To recover from it:

1. Quit SnAgentsOS completely (tray icon > Quit if it is set to close to the tray).
2. Open the zip (Explorer, Finder or `tar -xf migration-backup-v1.zip`) and copy `config.json` and `remote-devices.json` into the data folder above, replacing the current ones.
3. Start SnAgentsOS.

**Going back to SnMultiCC 1.x is not supported.** The old data folder no longer exists, so a reinstalled 1.14.1 starts empty, and it does not recognize the new Claude Code hooks: if you do it anyway, disable the integration in SnAgentsOS (**Settings > Notifications**) first. Running a 1.x portable next to 2.x is not supported either (both would fight over the Claude Code hooks).

**Good to know**

- **Firewall (Windows):** the old firewall rule for `SnMultiCC.exe` stays behind, inert, because its program no longer exists (removing it needs admin rights, and the app never asks for them). With remote control on, Windows asks for permission for SnAgentsOS once: allow it on private networks and paired phones reconnect by themselves, with no new QR.
- **Taskbar pin (Windows):** if the pin survives the upgrade, the app points it to SnAgentsOS. The old uninstaller may remove it, though, and Windows does not let apps pin themselves: in that case the notice asks you to pin SnAgentsOS again.
- **Installed for all users:** the setup asks for admin rights (UAC), as every 1.x update did. If you picked "Only for me" on top of a per-machine 1.x, uninstall SnMultiCC from **Settings > Apps** (the notice says so too).
- **Portable:** only what sits next to the `.exe` is cleaned; a 1.x portable in another folder is not touched. Do not keep a portable (or its data folder) inside the installation folder: the setup stops and asks you to move it.
- **Phone:** the web client keeps its pairing. A home-screen app added on iOS keeps the old name until you remove it and add it again; Android picks up the new name.
- **macOS:** `SnMultiCC.app` is moved to the Trash. If macOS denies it (an app installed by another user), the notice asks you to move it yourself.
- **Linux:** the old `.deb` needs root, so remove it yourself with `sudo apt remove snmulticc`. An AppImage still named after SnMultiCC is renamed to `SnAgentsOS.AppImage` in place; `.desktop` launchers you created for the old file name are not updated.

<!-- legacy-end -->

## Tech

- **Electron** + **React** + **Vite** + **TypeScript** (via [`electron-vite`](https://electron-vite.org)).
- Terminals: [`xterm.js`](https://xtermjs.org) + [`node-pty`](https://github.com/microsoft/node-pty) (N-API, no native rebuild).
- State: `zustand` · Validation + config schema: `zod` · Layout: a custom CSS-grid tiling engine.
- Styling: **Tailwind CSS v4**, `framer-motion`, `lucide-react`.
- Packaging: `electron-builder`.

## Development

```bash
npm install
npm run dev        # launch with HMR
npm run typecheck  # type-check main + renderer
npm test           # status, rebrand and migration regressions, then the brand guard
npm run test:ui    # isolated Electron visual smoke, after npm run build
npm run test:mobile # real xterm touch-scroll regression, after npm run build:mobile
```

## Build

```bash
npm run pack:dir   # unpacked app (quick sanity build)
npm run dist:win   # Windows: NSIS installer + portable .exe
npm run dist:mac   # macOS: dmg + zip
npm run dist:linux # Linux: AppImage + deb
```

## License

[MIT](./LICENSE) © Valentin Tarnovsky
