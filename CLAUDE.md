# SnAgentsOS

Electron 33 + React 19 + xterm.js 5.5 + node-pty. Centro de mando de agentes (Claude Code, Codex) y terminales, con un cliente web mobile (`src/mobile`) que sirve el `RemoteServer` del desktop.

- UI y copy: `docs/STYLEGUIDE.md` (tokens desktop y mobile, primitivos, i18n).
- Contratos entre epics (WS, IPC, claves de config, atajos, owners): `docs/snagentsos/CONTRATOS.md`. Si un PRD o el plan lo contradicen, gana el contrato.

## Reglas

- Nunca mandar Enter automatico a una consola sin opt-in explicito del usuario (Quick Commands, composer, CLI, automatizaciones). El texto se inserta; el `\r` solo con la opcion activada y una senal de estado precisa.
- Canvas es el renderer por defecto del terminal; WebGL es opt-in. `@xterm/xterm` va pineado exacto en 5.5.0 (igual que `addon-canvas`, `headless`, `addon-serialize` y `addon-unicode11`); no se sube a xterm 6.
- Cada tanda de claves de config nuevas sube `CONFIG_VERSION` (`src/shared/types.ts`) una sola vez, con default de zod por campo en `src/main/store/schema.ts`. `migrate()` solo agrega logica cuando hay transformacion. Los schemas 11 a 14 viajan juntos en 2.0.0 como migraciones secuenciales.
- `src/shared` no importa nada de Node (`fs`, `path`, `electron`...) ni del DOM: lo consumen main, renderer y mobile.
- El unmount de un pane nunca mata su pty: los kills son explicitos (`pty.kill`, `killPanePtys`). El cleanup de `useXterm` ya no mata (E4-FR-36): un remount, un error boundary o un reload se reengancha al pty vivo; los kills por cierre son de `ptyLifecycle`.
- Todo archivo persistente nuevo vive bajo `dataDir()` (`src/main/paths.ts`), nunca bajo `app.getPath('userData')` directo. Logs en `dataDir()/logs/<nombre>.log`. Escritura atomica `tmp` + `rename`, UTF-8 sin BOM.
- Todo archivo que porte o adapte codigo de stablyai/orca lleva en la primera linea `// Adaptado de stablyai/orca (MIT) - <ruta original>`; la licencia esta en `THIRD_PARTY_NOTICES.md`. No se usa su nombre ni su marca en la UI.
- Main es autoritativo (estado de agentes, procesos, archivos). Ningun canal acepta rutas del renderer o del celu sin validarlas en main.
- Protocolo WS: `PROTOCOL_VERSION` queda en 1 y todo campo nuevo es opcional. Cada ctl nuevo se declara en `RemoteCtlAction`, `ctlActionSchema` y `src/renderer/lib/remoteCommands.ts`. Canales IPC con forma `domain:action` en `src/shared/ipc-channels.ts`.
- Strings visibles con clave es/en: `src/renderer/i18n`, `src/main/i18n.ts`, `src/mobile/src/lib/i18n.ts`.
- Prohibidos el em dash y el en dash en todo el repo, y el nombre de producto anterior fuera de la allowlist de `scripts/check-brand.cjs` (identidad vieja solo en `LEGACY_BRAND` de `src/shared/brand.ts`).

## Nombres

Producto SnAgentsOS (`BRAND` en `src/shared/brand.ts`). Prefijos: env `SNAOS_`, CLI `snaos`, archivo por repo `.snagentsos.json`, skill `~/.claude/skills/snagentsos`, localStorage y sessionStorage `snagentsos.`, carpeta portable `snagentsos-data`, userData de dev `snagentsos-dev`.

## Verificacion

```
npm run typecheck   # node + web + mobile
npm test            # suites esbuild + vm y check-brand
npm run build       # requerido antes de las suites Electron
npm run test:ui     # Electron offscreen (desktop)
npm run test:mobile # Electron offscreen (cliente mobile)
```

Tests nuevos con el mismo arnes: esbuild + vm como `scripts/test-status.cjs`, Electron offscreen como `scripts/test-status-ui.cjs`; cada suite nueva se suma al script de `package.json` que corresponda.

## Probar en runtime

La app es de instancia unica por perfil: una segunda corrida con el mismo userData solo enfoca la primera (y `snagentsos-dev` lo comparten todos los worktrees). Probar siempre con un perfil desechable:

```
npm run build
node_modules/electron/dist/electron.exe out/main/index.js --user-data-dir=<temp>
```

Sin `ELECTRON_RENDERER_URL`, con `CLAUDE_CONFIG_DIR` y `CODEX_HOME` apuntando a carpetas temporales (los hooks nunca tocan `~/.claude` real) y otro puerto remoto en la config del perfil. Nunca abrir un build empaquetado (`release/**`, setup, portable, `win-unpacked`) en una maquina con datos reales: migra y borra los datos de 1.x.
