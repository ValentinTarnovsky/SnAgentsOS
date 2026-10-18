## Contratos compartidos

Fuente unica de verdad para todos los epics. Si un PRD contradice esta seccion, gana esta seccion. Los nombres en ingles son identificadores de codigo.

### Reglas generales

- `PROTOCOL_VERSION` se queda en `1` hasta v3.0. Todas las adiciones WS son aditivas. El cliente ignora tipos desconocidos (el switch de `client.ts` no tiene default) y el bundle mobile lo sirve el mismo desktop; un bundle viejo se detecta con `authOk.appVersion` vs `__APP_VERSION__` (M2).
- Cada ctl nuevo se declara en `RemoteCtlAction` (src/shared/remote-protocol.ts), en `ctlActionSchema` (src/shared/remote-protocol-schemas.ts) y en el executor `src/renderer/lib/remoteCommands.ts`. Cada mensaje C->S nuevo entra en `remoteClientMsgSchema`.
- Limites vigentes: frame WS 64KB (`MAX_PAYLOAD`), `input.data` <= 8192, `globalPrompt.text` <= 16384. Lo que no entra se trocea o va por HTTP.
- Main es autoritativo para `running` y para `status` de cada pane en el snapshot (overlay en `RemoteManager`).
- Archivos persistentes nuevos: siempre bajo `dataDir()` = `dirname(getConfigPath())` (lo crea E0). Nunca bajo `app.getPath('userData')` directo (excepcion heredada: `status-bin`, que vive en `userData` tambien en la portable). Ninguna epica escribe en `backups/` archivos que no sean `config-*.json` (la escalera de `ConfigStore` ordena alfabeticamente todos los `*.json` de ahi). Los logs propios van a `dataDir()/logs/<nombre>.log`.
- Nombres reservados por la migracion del legado (E0, ver "Migracion del legado"): ninguna otra epica los usa ni los borra.
- Prefijos: env `SNAOS_`, localStorage `snagentsos.`, CLI `snaos`, archivo por repo `.snagentsos.json`, skill `~/.claude/skills/snagentsos`.

### Versiones de schema de config

| Release | CONFIG_VERSION | Motivo |
|---|---|---|
| v2.0.0 | 10 (sin cambio) | Rebrand: se reubica el directorio de datos y se migra automaticamente desde 1.x. El estado de la migracion (fases, verificacion, respaldo, vencimiento, limpieza, `noticeSeen`) vive en `dataDir()/legacy-migration.json`, nunca en `config.json` |
| v2.1.0 | 11 | awakeMode, terminalUnicode11, pane.lastSession, notifications.inAppWhenFocused, settings.agents.* (v11), workspaces[].agentsCollapsed, terminalAgentEndChip |
| v2.2.0 | 12 | update, ntfy, scrollback, git, explorer, quickCommands (migracion real de snippets) |
| v3.0.0 | 13 | phoneFit, https, CLI, worktrees, repoConfigTrust, automations, hibernacion |
| v3.1+ | 14+ | Items "mas adelante" no agendados |

Entrega consolidada (decision del usuario): todo lo agendado para v2.1, v2.2, v3.0 y v3.1 sale junto en una sola release, 2.0.0 (`package.json` no cambia de version). Los schemas 11 a 14 se conservan como migraciones secuenciales con los numeros de esta tabla, asi una config v10 recorre 11, 12, 13 y 14 en orden. Donde este documento dice "v2.1", "v2.2", etc. nombra el tramo del plan, no un tag publicado.

Las migraciones nuevas siguen el patron de defaults por campo en zod; `migrate()` solo agrega logica cuando hay transformacion (v12: snippets -> quickCommands).

La migracion de marca de v2.0.0 no es una migracion de schema: copia `config.json` v10 tal cual (verificado contra zod y por hash, E0-FR-27) y no pasa por `migrate()`. Una config legada con `version > CONFIG_VERSION` es falla de verificacion, no se migra y no se borra nada.

### Migracion del legado (E0, v2.0.0)

Decision del usuario: todo automatico. Al instalar SnAgentsOS se migra todo SnMultiCC y se borran solos los restos viejos (inventario L01-L21 de E0). No hay boton manual de reimportar ni de borrar (E0-FR-11 retirado) y **el rollback a 1.x no esta soportado**. La unica red de seguridad es `migration-backup-v1.zip`, un solo archivo dentro de la carpeta nueva que se borra solo a los 30 dias: es deliberado y no cuenta como "dejar lo viejo".

Nombres reservados en `dataDir()` (y junto a la carpeta legada):

| Ruta | Contenido | Escribe / borra |
|---|---|---|
| `legacy-migration.json` | Marcador v2 (contrato abajo) | Main, `tmp` + `rename`, UTF-8 sin BOM, una escritura por transicion y por item de limpieza |
| `legacy-migration.prev.json` | Copia de la version anterior del marcador, hecha antes de cada escritura | Main |
| `legacy-migration.json.corrupt-<ISO>` | Marcador ilegible apartado (main y `prev` invalidos) | Main; nunca se lee de vuelta |
| `.legacy-staging/` | Copia de trabajo durante `migrating` / `verified`; se vacia en cada reinicio y en cada falla | Main |
| `pre-import/config-<ISO>.json` (+ `config-<ISO>.json.bak`) | Config que ya tenia el destino antes de que gane el legado (marcador previo a `committed`). Sin duplicados por SHA-256 (ni de `sources` ni de otra instantanea). Rotacion: se conservan la **primera** y las 2 mas nuevas | Main |
| `migration-backup-v1.zip` | Respaldo de seguridad (contrato abajo) | Main; se borra solo al vencer |
| `logs/legacy-migration.log` | Una linea por transicion e item (fase, item, resultado, codigo, ruta), sin contenido ni secretos; rota a 256 KB y conserva 1 | Main |
| `<carpeta legada>.deleting-<ISO>` (junto a `snmulticc`, `snmulticc-data` o `snmulticc-dev`) | Tombstone del borrado en dos pasos (rename atomico y despues borrado) | Main; la deteccion del legado lo ignora y la limpieza lo termina de borrar |

Contrato del marcador (`src/main/migration/legacyMarker.ts`, owner E0; la forma completa esta en E0, "FR-27..FR-36"):

- `v: 2`. Un `v: 1` (solo builds de prueba) o cualquier otro valor se trata como ausente.
- `phase`: `migrating -> verified -> backedUp -> committed -> cleaning -> done`, mas `failed`. `outcome: 'migrated' | 'noLegacy'` se fija en `committed`; `noLegacy` entra directo a `committed`.
- **Escribir `phase: 'committed'` con `committedAt` es la unica condicion que habilita borrar algo legado.** Antes de eso los archivos legados nunca se escriben ni se borran.
- Reanudacion al arrancar: `migrating`, `verified`, `backedUp` y `failed` reinician desde migrar (staging vaciado); `committed` y `cleaning` reanudan la limpieza; `done` solo hace mantenimiento (vencimiento del zip). Con el marcador en `committed` o posterior no se vuelve a copiar nada: si las fuentes legadas cambian despues del commit, los archivos cambiados van al zip como `post-commit/<ISO>/`, se registra `postCommitBackup` y ganan los datos de 2.x.
- Campos: `phase`, `outcome?`, `mode: 'installed' | 'portable'`, `from` (carpeta legada o null), `to` (`dataDir()`), `attempts`, `sources: Array<{ rel, bytes, sha256, mtimeMs }>`, `verified?: { at, legacyConfigLoadable, effectiveConfigSha256, workspaces, presets, devices, backups }`, `preImportSnapshot?`, `backup?: { file, bytes, sha256, entries, createdAt, expiresAt, deletedAt? }`, `committedAt?`, `postCommitBackup?: { at, entries }`, `hooksMigration: 'pending' | 'rewritten' | 'notNeeded'`, `loginItemMigrated`, `pinRetargeted?`, `portableExeRenamedTo?`, `cleanup: Partial<Record<LegacyItemId /* L01..L21 */, { state, attempts, reason?, at? }>>`, `cleanupStarts`, `noticeSeen`, `lastError?: { phase, code, at }` (sin contenido de archivos), `appVersion`, `at`.
- Estado por item: `pending | done | absent | skipped | deferred`. La fase pasa a `done` cuando todos estan en `done`, `absent` o `skipped`. Motivos de `skipped` (`reason`): `guard`, `reparsePoint`, `needsElevation`, `readOnly`, `unknownFiles` (L01, L04), `ownedByInstalled` (L03), `nameConflict` (L17), `unexpectedUninstallEntry` (L05). `needsElevation` nunca queda `deferred` ni dispara UAC: se informa como accion manual (`LegacyDataInfo.manualActions`).
- `readMarker(dir): ReadMarkerResult` = `{ kind: 'absent' } | { kind: 'ok'; marker; from: 'main' | 'prev' } | { kind: 'corrupt' }`. Ilegible usa `prev`; si `prev` tambien es ilegible, se aparta como `.corrupt-<ISO>` y, con carpeta legada presente y destino con `config.json` o zip, la fase queda `failed` con `lastError.code: 'markerCorrupt'` (no se migra encima ni se limpia). Sin carpeta legada se reconstruye como `noLegacy`.
- Main es el unico dueno. El renderer solo lo lee por `app:legacyInfo` / `app:legacyStatus` y solo puede pedir `noticeSeen = true` (`app:legacyAck`).

Contrato del respaldo (`src/main/migration/backupZip.ts`, writer propio con `zlib`, sin dependencias nuevas):

- Ruta fija `dataDir()/migration-backup-v1.zip`. `manifest.json` es la primera entrada: `{ v: 1, appVersion, createdAt, expiresAt, entries: Array<{ name, source, bytes, sha256 }> }`.
- Grupos de entradas: archivos legados de la lista blanca en su ruta relativa (`config.json`, `config.json.bak`, `remote-devices.json`, `backups/config-*.json`, tambien los corruptos), `claude/settings.json.snmulticc.bak`, `dev/config.json` y `dev/remote-devices.json` (de `snmulticc-dev`), `other/<nombre>` (entradas desconocidas de primer nivel de la carpeta legada, tope 5 MB) y `post-commit/<ISO>/...`. Nunca `status-bin`, Chromium ni ejecutables. Tope total 20 MB: si se pasa, la fase falla y no se limpia.
- Se escribe a `.tmp` + `rename`, se reabre y se verifica cada entrada contra el manifest antes de `backedUp`. Cada reescritura (`post-commit/`) conserva `createdAt` y `expiresAt` originales.
- Vencimiento: `expiresAt = createdAt + BACKUP_TTL_MS` (30 dias, fijo, sin ajuste en la UI ni clave de config; E0-Q14). Se borra en el primer arranque posterior o en el chequeo diario con la app abierta, con el marcador en `committed`, `cleaning` o `done`, y se registra `backup.deletedAt`. Con el reloj atrasado no se borra antes.
- Contiene secretos de devices: mismo ACL que la carpeta de datos, nunca se loguea ni se sube.

Registro de Windows (escrito por `build/installer.nsh`, leido y borrado por la app): `SHCTX\Software\8c5f793e-c93a-5e95-add6-ae90c4af8c04\LegacyInstallLocation` (REG_SZ) y `...\LegacyTaskbarPinned` (`1` si existia el pin), en HKCU (per-user) o HKLM (per-machine). La app lee los dos hives y borra los valores cuando L04 y L08 quedan en estado terminal. La clave de desinstalacion del mismo GUID es de 2.x y nunca se borra.

Variables de entorno de la migracion: `SNAOS_FORCE_LEGACY_MIGRATION=1` (corre el pipeline en dev, hacia `snagentsos-dev`), `SNAOS_FORCE_LEGACY_CLEANUP=1` (limpieza real en dev; sin ella es simulacion, solo log; usar solo con un `APPDATA` falso) y `SNAOS_TEST_FAULT=<fase|item>` (solo se lee si el build define `__SNAOS_TEST_FAULTS__`, falso en el release). El `userData` de dev es `<appData>/snagentsos-dev` (E0-FR-26).

### Tipos compartidos nuevos

- `LegacyPhase`, `LegacyItemId`, `LegacyItemState`, `LegacyMigrationMarker` y `ReadMarkerResult` (v2.0, E0): en `src/main/migration/legacyMarker.ts`, solo main.
- `LegacyDataInfo` (v2.0, E0, `src/shared/ipc-contract.ts`): `{ phase: LegacyPhase | null; outcome: 'migrated'|'noLegacy'|null; counts: { workspaces, presets, devices, backups } | null; cleanup: { pending, deferred, done, skipped }; showDeferredBanner: boolean /* algun deferred y cleanupStarts >= 5 */; failure: { phase, attempts } | null; backup: { path, expiresAt } | null; pinRetargeted: boolean | null; manualActions: Array<'uninstallPerMachine'|'trashMacApp'>; firewallHint: boolean; noticeSeen: boolean }`. Las rutas las calcula main; el renderer nunca manda rutas.
- `RemotePaneStatus` (v2.1, owner E4 datos / E1 transporte): `{ state: ClaudePaneState; precise?: boolean; provider?: 'claude'|'codex'; reason?: AttentionReason; pendingCount?: number; stateSince: number; lastMessage?: string /* <= 280 */; activity?: string /* tool actual, <= 120 */; pending?: RemotePending[] }`. `precise` (enmienda v2.1, riesgo 22 de E1) copia `PaneStatus.precise`: `false` = estado inferido del titulo OSC (panes SSH o sin hooks) y el celu agrega "(aproximado)"; ausente se trata como `true`.
- `RemotePending`: `{ id: string /* toolUseId */; kind: 'permission'|'question'|'plan'|'elicitation'; toolName?: string; summary: string /* <= 200 */; questions?: Array<{ question: string; header?: string; multiSelect: boolean; options: Array<{ label: string; description?: string }> }> }`
- `PaneStatus` / `PaneStatusEvt` (desktop) ganan los mismos campos mas `sessionId?: string` y `cwd?: string` (solo main -> renderer, nunca al celu). `stateSince` marca la ultima transicion de estado y es distinto de `updatedAt`.
- Campos desktop-only de `PaneStatus` / `PaneStatusEvt` (enmienda v2.1, owner E4/E5, nunca viajan al celu ni entran en `RemotePaneStatus`): `detail?: AgentDetail` (`{ kind: 'tool'|'prompt'|'question'|'permission'|'plan'|'reply'; text: string /* <= 160, sin C0/C1 ni ANSI */ }`), `topic?: string` (texto del OSC title despues del glifo, <= 60), `firstPrompt?: string` (primera linea del primer UserPromptSubmit, <= 60; se reinicia en `start`) y `cacheSince?: number` (transicion working -> done/idle de Claude). Una emision `state: null` los borra en el renderer.
- `AgentSessionEndEvt` (v2.1, E6, `src/shared/types.ts`): `{ paneId; ptyId; provider: 'claude'; sessionId; reason: 'prompt_input_exit' | 'other'; cwd?: string; at: number }`. Solo se emite para la sesion principal (sin `agentId`) y con `reason` en la allowlist.
- `PtyRestartReq` / `PtyRestartRes` (v2.1, E6, `src/shared/ipc-contract.ts`): `PtyRestartReq = PtySpawnReq & { fallbackDefaultShell?: boolean }` (sin `restoreScrollback` cuando ese campo exista en v2.2); `PtyRestartRes = { ptyId; tail: string /* SOFT_RESET + separador localizado */; shellKind: ShellKind; warning?: PtySpawnRes['warning'] }`.
- `AgentSessionView`, `AgentsStartup`, `ExitTrigger` y `LaunchDecision` (v2.1, E5, `src/shared/agents.ts`): forma completa en E5 "G2 - Retomar". `agent-sessions.json` es main-owned; el renderer solo lo ve por `agents:*`.
- `QuickCommand` (v2.2, E5): `{ id: string; name: string; text: string; workspaceId?: string /* ausente = global */; action: 'send'|'agent'; enter: boolean; presetId?: string }`
- `buildAgentArgv({ preset, resume?: { provider, sessionId }, prompt? })` en `src/shared/agent-argv.ts` (v2.1, E4), unico constructor de argv de agentes.

### Protocolo WS: adiciones

| Release | Dir | Mensaje / campo | Forma | Owner |
|---|---|---|---|---|
| v2.1 | S->C | `paneStatus` | `{ paneId, status: RemotePaneStatus \| null }` | E1 (datos E4) |
| v2.1 | S->C | `RemotePaneInfo.status?` | `RemotePaneStatus` en `state` y `authOk` | E1 |
| v2.1 | ctl | `restartPane.resume?` | `boolean` (true = relanzar retomando, false = chat nuevo) | E4 |
| v2.1 | S->C | `RemotePaneStatus.precise?` | `boolean` (ausente = `true`) | E1 (datos E4) |
| v2.1 | S->C | `RemotePaneInfo.resumable?` | `boolean`, calculado en `remoteSnapshot.ts`: `true` si el pane es de agente, no tiene Connection Profile SSH y hay sesion retomable (D10). Ausente = ocultar "Relanzar retomando" y "Chat nuevo" | E5 (consumen E1/E2) |
| v2.1 | S->C | `RemoteStateSnapshot.terminalUnicode?` | `'6' \| '11'` (ausente = `'6'`) | E6 |
| v2.1 | S->C | `replay.exitCode?` | `number`, presente con `running: false` cuando el pty salio solo (no en un spawn lazy pendiente) | E6 |
| v2.1 | S->C | `RemotePaneInfo.exitCode?` | `number`, superpuesto por main como `running` (`ptyManager.exitedPaneCodes()`) | E6 |
| v2.2 | S->C | `RemoteStateSnapshot.presets?` | `Array<{ id, name, type, icon, color }>` | E2 |
| v2.2 | ctl | `createPane.prompt?` | `string` <= 16384 | E2 |
| v2.2 | ctl | `openPath` | `{ workspaceId, paneId, path }` | E2 |
| v2.2 | S->C | `RemoteWorkspaceInfo.git?` | `{ branch, ahead, behind, added, removed, files }` | E5 |
| v2.2 | S->C | `RemoteStateSnapshot.quickCommands?` | `QuickCommand[]` (reemplaza `snippets`) | E5 |
| v2.2 | ctl | `runQuickCommand` | `{ workspaceId, paneId?, id }` | E5 |
| v2.2 | S->C | `RemotePaneInfo.agentEnded?` | `{ canResume: boolean }`, calculado en `remoteSnapshot.ts`: presente mientras el desktop ofrece el chip "Claude termino" (`agentEnded[paneId]` con `terminalAgentEndChip` encendido); `canResume: false` = solo [Nueva]. Nunca lleva el `sessionId` | E6 |
| v2.2 | ctl | `agentResume` | `{ workspaceId, paneId, mode: 'resume' \| 'new' }`; el executor del renderer tipea el mismo texto que el chip del desktop. Errores de `ctlAck`: `not_found` (pane fuera de `workspaceId`), `stale` (sin oferta: ya la tomo otro dispositivo, el desktop o el ajuste esta apagado), `no_resume`, `not_running` (sin pty viva; la oferta se descarta) | E6 |
| v3.0 | S->C | `authOk.httpToken` | `string` hex 64, por sesion | E3 |
| v3.0 | HTTP | `POST /api/upload` | `Authorization: Bearer <httpToken>`, png/jpg/webp, <= 10MB -> `{ path }` | E3 |
| v3.0 | ctl | `fitPane` | `{ workspaceId, paneId, cols, rows }` (min 20x8) | E3 |
| v3.0 | ctl | `releaseFit` | `{ paneId }` | E3 |
| v3.0 | S->C | `fitState` | `{ paneId, owner: 'phone'\|'desktop', cols, rows }` | E3 |
| v3.0 | C->S | `chatSub` / `chatUnsub` | `{ paneId }` | E3 |
| v3.0 | C->S | `chatMore` | `{ paneId, before: string }` | E3 |
| v3.0 | S->C | `chatPage` | `{ paneId, items, cursor, done }` | E3 |
| v3.0 | S->C | `chatAppend` | `{ paneId, items }` | E3 |
| v3.0 | C->S | `historyReq` | `{ id, query?, workspaceId? }` | E3 |
| v3.0 | S->C | `historyRes` | `{ id, sessions: Array<{ provider, sessionId, cwd, title, updatedAt }> }` | E3 |
| v3.0 | ctl | `createPane.resume?` | `{ provider: 'claude'\|'codex', sessionId }` | E3 |
| v3.0 | C->S | `gitReq` | `{ id, workspaceId, op: 'status'\|'diff', path?, staged?, page? }` | E3 |
| v3.0 | S->C | `gitRes` | `{ id, ok, data, page, done }`, frame <= 48KB | E3 |
| v3.0 | ctl | `sendReviewNotes` | `{ workspaceId, paneId, notes: Array<{ file, lines, comment }>, enter: boolean }` | E3 (formato E6) |
| v3.0 | S->C | `authOk.pushKey?` | clave VAPID publica (solo con https) | E3 |
| v3.0 | HTTP | `POST /api/push/subscribe` | Bearer `httpToken`, body PushSubscription | E3 |

Sin mensaje nuevo: respuestas a permisos/preguntas (`input` con "1", Esc, digitos), Stop del composer (`input` "\x1b"), pausa del xterm en vista Chat (`unsub`/`sub`), reconexion (ping/pong existentes).

### IPC: adiciones (src/shared/ipc-channels.ts)

| Release | Canal | Tipo | Payload / retorno | Owner |
|---|---|---|---|---|
| v2.0 | `app:legacyInfo` | invoke | `-> LegacyDataInfo` | E0 |
| v2.0 | `app:legacyAck` | send | sin payload; marca `noticeSeen = true` en el marcador | E0 |
| v2.0 | `app:legacyShowBackup` | send | sin payload; `shell.showItemInFolder` del zip (ruta calculada en main) | E0 |
| v2.0 | `app:legacyOpenLog` | send | sin payload; `shell.openPath` de `logs/legacy-migration.log` | E0 |
| v2.0 | `app:legacyStatus` | main->renderer | `LegacyDataInfo` en cada cambio de la limpieza | E0 |
| v2.1 | `power:setConfig` | send | `'auto'\|'always'\|'never'` | E4 |
| v2.1 | `power:state` | main->renderer | `PowerState` = `{ blocking: boolean; reason: 'agents'\|'always'\|null; mode?: 'auto'\|'always'\|'never'; display?: boolean; workingCount?: number; releaseAt?: number /* epoch ms, solo en la gracia de 120 s */ }`. Los opcionales (enmienda v2.1) alimentan el tooltip de E5-FR-24 ("2 agentes trabajando (Auto)", "se libera en 1:45") | E4 |
| v2.1 | (preload, sin IPC) `snApi.files.pathForFile` | sync | `File -> string` via `webUtils.getPathForFile` | E4 |
| v2.1 | `status:state` (existente) | main->renderer | `PaneStatusEvt` extendido (stateSince, lastMessage, activity, pending, sessionId, cwd, detail, topic, firstPrompt, cacheSince) | E4 |
| v2.1 | `power:getState` | invoke | `-> PowerState` (estado inicial; los cambios llegan por `power:state`) | E4 |
| v2.1 | `pty:restart` | invoke | `PtyRestartReq -> PtyRestartRes`; rechaza con Error si el spawn falla. Reinicio en el lugar: conserva el contenido y no emite `exit` al celu | E6 |
| v2.1 | `status:sessionEnd` | main->renderer | `AgentSessionEndEvt` | E6 |
| v2.1 | `agents:list` | invoke | `-> AgentSessionView[]` | E5 |
| v2.1 | `agents:startup` | invoke | `-> AgentsStartup` (estable durante la ejecucion) | E5 |
| v2.1 | `agents:consumeStartup` | invoke | `paneId -> boolean` (true solo la primera vez en la ejecucion) | E5 |
| v2.1 | `agents:changed` | main->renderer | `AgentSessionView \| { paneId: string; removed: true }`, solo si cambia un campo de la vista | E5 |
| v2.1 | `agents:forget` | send | `paneId` | E5 |
| v2.1 | `agents:ready` | main->renderer | `{ paneId, sessionId, phase: 'start' \| 'idle' }` | E5 |
| v2.1 | `agents:setConfig` | send | `AgentSettings` (`settings.agents`) | E5 |
| v2.1 | `agents:settingsPatch` | main->renderer | `Partial<AgentSettings>` (cambio desde el tray; el renderer persiste) | E5 |
| v2.2 | `agents:startupPending` | invoke | `paneIds (string[], <= 1000) -> string[]`: los que todavia no gastaron su decision de arranque, sin gastarla (enmienda R22-09: el modal de retomar no vuelve a preguntar tras recargar el renderer) | E5 |
| v2.2 | `app:diagnostics` | invoke | `RendererDiagnostics -> string` redactado, <= 64KB, armado por allowlist (enmienda R22-03: el renderer aporta conteos y sus ultimos 10 errores) | E5 |
| v2.2 | `app:takeRecovery` | invoke | `-> RecoveryInfo \| null` (`{ at, reason, exitCode, consoles, autoReloadsInWindow }`), se consume una vez; reemplaza a `app:rendererRecovered` (pull, enmienda R22-03) | E5 |
| v2.2 | `app:reload` | send | sin payload; recarga manual, resetea el breaker y descarta la recuperacion pendiente | E5 |
| v2.2 | `app:reportRenderError` | send | `RenderErrorReport` (`{ scope, paneId?, message, stack?, componentStack?, at }`), validado con zod y con throttle en main | E5 |
| v2.2 | `app:openPath` | main->renderer | `OpenRequest` = `{ id, path, source: 'argv' \| 'second-instance' }`, superset de `{ path }` (primer arranque y second-instance `--open`; enmienda R22-06) | E5 |
| v2.2 | `app:takePendingOpen` | invoke | `-> OpenRequest \| null` (consume el pedido que main retiene hasta que el renderer hidrata; enmienda R22-06) | E5 |
| v2.2 | `system:setExplorerMenu` | invoke | `{ enabled, language } -> ExplorerMenuResult` = `{ ok, registered, exe?, currentExe?, mismatch?, error?, skipped?: 'not-windows' \| 'dev' }` (enmienda R22-06, forma del PRD E4) | E5 |
| v2.2 | `system:getExplorerMenu` | invoke | `-> ExplorerMenuResult` (enmienda R22-06) | E5 |
| v2.2 | `pty:scrollbackLoad` | invoke | `paneId -> string \| null` | E5 |
| v2.2 | `pty:setEngine` | send | `TerminalEngineSettings` = `{ snapshotMode: 'auto' \| 'lazy' \| 'off'; unicode11; persist; persistLines; shellIntegration? }`, normalizado en main (enmienda R22-07). `PtyReattachRes` suma `cols`/`rows`/`shellKind` (E6-FR-04) y `AppMetrics.headless?: { panes, parseMsP95, snapshotMsP95, bytesParsed, snapshotCacheHits }` (E6-FR-07) | E6 |
| v2.2 | `git:setWatch` | send | `GitTarget[]` = `{ key, cwd, workspaceId, paneId?, active }` (enmienda R22-10: la clave `ws:<id>` / `pane:<id>` y `active` acompanan al cwd) | E5 |
| v2.2 | `git:update` | main->renderer | `{ key, cwd, summary: GitSummary \| null, error? }`, solo cuando cambia por valor | E5 |
| v2.2 | `git:info` | invoke | `{ force? } -> GitInfoRes` (enmienda D6) | E5 |
| v2.2 | `fs:dirExists` | invoke | `string -> boolean`: si una ruta absoluta es una carpeta existente; relativa, vacia, con NUL o de mas de 4096 caracteres -> `false`; un stat que tarda mas de 1,5 s -> `true` (solo alimenta el aviso "La carpeta no existe" del composer, nunca bloquea; enmienda R22-13) | E8 |
| v2.2 | `git:setConfig` | send | `{ gitChip: boolean }` (enmienda D6) | E5 |
| v2.2 | `git:refresh` | send | `{ keys?, reason?: 'manual' \| 'agent' }` (enmienda D6) | E5 |
| v2.2 | `git:status` | invoke | `{ key } -> GitChangesRes \| null` = `{ summary, files: GitFileEntry[] }` con `+a -d` por area (enmienda R22-11: por clave de target como `git:setWatch`, no por cwd) | E5 |
| v2.2 | `git:fileDiff` | invoke | `{ key, path, area, force? } -> GitDiffRes \| { error: GitError \| 'gone' \| 'denied' }`; `GitDiffRes` = `{ path, oldPath?, area, binary, diffRev, tooLarge?: { lines, bytes }, hunks, totalLines }` (enmienda R22-11: solo paths de la ultima lista de main para esa clave) | E5 |
| v2.2 | `git:openFile` | invoke | `{ key, path, reveal? } -> boolean` (lista blanca de extensiones de E7-FR-15 en main; el resto se muestra en la carpeta; enmienda D6/R22-11) | E5 |
| v2.2 | `git:setPanel` | send | `{ key: string \| null }`, target del panel Changes abierto (poll de 3 s, E7-FR-06e; enmienda R22-11) | E5 |
| v2.2 | `update:check` (existente) | invoke | `UpdateInfo` + `newerCount: number` | E5 |
| v2.2 | `status:ntfyTest` | invoke | `-> { ok, error? }` | E2 |
| v2.2 | `remote:firewallCheck` | invoke | `-> { ok, profile, ruleFound }` | E2 |
| v2.2 | `remote:firewallFix` | invoke | `-> { ok, error? }` (UAC) | E2 |
| v2.2 | `shell:openPath` | invoke | `{ cwd, path } -> { ok, error? }` con validacion de contencion | E2 |
| v2.2 | `pty:submit` | invoke | `PtySubmitReq` = `{ ptyId, paneId?, text /* <= 256 KB */, enter } -> PtySubmitRes` = `{ ok: true } \| { ok: false; error: 'multiline_unsafe' \| 'not_running' }`. `paneId` (enmienda R22-12) resuelve el pty vivo del pane cuando `ptyId` falta o quedo viejo | E5 |
| v2.2 | `pty:promptResult` | main->renderer | `PtyPromptResultEvt` = `{ paneId, result: 'sent_argv' \| 'sent_gate' \| 'inserted_unconfirmed' \| 'not_delivered' \| 'dropped_exit' }` | E5 |
| v3.0 | `remote:fitRelease` | send | `{ paneId } \| { all: true }` | E3 |
| v3.0 | `sessions:list` | invoke | `{ query?, cwd? } -> SessionSummary[]` | E3 |
| v3.0 | `repoConfig:read` | invoke | `cwd -> { config, sha256, trusted } \| null` | E6 |
| v3.0 | `repoConfig:trust` | invoke | `{ cwd, sha256 } -> void` | E6 |
| v3.0 | `repoConfig:export` | invoke | `workspaceId -> boolean` | E6 |
| v3.0 | `git:worktreeAdd` | invoke | `{ repoRoot, slug, base?, copyEnv, linkNodeModules } -> { path, branch }` | E6 |
| v3.0 | `git:worktreeRemove` | invoke | `{ path, deleteBranch } -> void` | E6 |
| v3.0 | `cli:setEnabled` | send | `boolean` | E6 |

Los `agents:awake` / `agents:awakeGet` de E5 no existen: el estado de "PC despierta" usa `power:setConfig`, `power:state` y `power:getState` (R21-06; gana el contrato). `PowerState` cubre lo que E5 ponia en `AwakeState`: `reason: 'agents'` agrupa `working` y `phone`, y la gracia se ve como `blocking: true` con `releaseAt`. `awakeDisplay` viaja en `agents:setConfig`.

No existen (E0-FR-11 retirado, verificacion negativa en E0): `app:legacyOpenDir`, `app:legacyImport` ni `app:legacyCleanup`. Ningun canal de E0 importa, borra ni acepta rutas desde el renderer.

El CLI `snaos` ejecuta open/spawn/send reutilizando `remote:controlCmd` / `remote:controlResult` y el executor de `remoteCommands.ts`.

### Claves de config

| Release (schema) | Clave | Tipo | Default | Owner |
|---|---|---|---|---|
| v2.0 (10) | ninguna | - | - | E0 |
| v2.1 (11) | `settings.awakeMode` | `'auto'\|'always'\|'never'` | `'auto'` | E4 |
| v2.1 (11) | `settings.terminalUnicode11` | boolean | `true` | E4 |
| v2.1 (11) | `workspaces[].panes[].lastSession` | `{ provider, sessionId, cwd, at }` opcional (`sessionId` cumple `SESSION_ID_RE`; un valor invalido se descarta) | ausente | E4 |
| v2.1 (11) | `settings.notifications.inAppWhenFocused` | boolean | `true` | E4 |
| v2.1 (11) | `settings.agents.resumeOnStartup` | `'ask'\|'auto'\|'off'` | `'ask'` | E5 |
| v2.1 (11) | `settings.agents.awakeDisplay` | boolean | `false` | E5 |
| v2.1 (11) | `settings.agents.sidebarAgentRows` | boolean | `true` | E5 |
| v2.1 (11) | `settings.agents.topicAsTitle` | boolean | `true` | E5 |
| v2.1 (11) | `settings.agents.ctrlDigitFocus` | boolean | `true` | E5 |
| v2.1 (11) | `workspaces[].agentsCollapsed` | boolean opcional | ausente | E5 |
| v2.1 (11) | `settings.terminalAgentEndChip` | boolean (`.catch(true)`) | `true` | E6 |
| v2.2 (12) | `settings.updateDismissedVersion` | string | `''` | E5 |
| v2.2 (12) | `settings.explorerMenu` | boolean | `false` | E5 |
| v2.2 (12) | `settings.persistScrollback` | boolean | `true` | E5 |
| v2.2 (12) | `settings.persistScrollbackLines` | number | `2000` | E5 |
| v2.2 (12) | `settings.gitChip` | boolean | `true` | E5 |
| v2.2 (12) | `quickCommands` (top-level) | `QuickCommand[]` | `[]` (migra `snippets`) | E5 |
| v2.2 (12) | `settings.notifications.ntfy` | `{ enabled, server, topic, token, notifyAction, notifyDone }` | `{ false, 'https://ntfy.sh', '', '', true, false }` | E2 |
| v2.2 (12) | `settings.notifications.onlyWhenAway` | boolean (umbral fijo 180s, estado desconocido no silencia) | `false` | E2 |
| v2.2 (12) | `settings.terminalSnapshotMode` | `'auto'|'lazy'|'off'` (`.catch('auto')`) | `'auto'` | E6 |
| v2.2 (12) | `settings.agents.resumeModalTimeoutSec` | number entero 0..600 (0 = nunca) | `60` | E5 |
| v2.2 (12) | `settings.agents.resumeNudge` | boolean | `false` | E5 |
| v2.2 (12) | `settings.agents.resumeNudgeText` | string (max 500; `''` = texto i18n) | `''` | E5 |
| v2.2 (12) | `settings.agents.sidebarSort` | `'manual'|'smart'` | `'manual'` | E5 |
| v2.2 (12) | `settings.automation.defaultAgentPresetId` | string (`''` = primer preset `claude`) | `''` | E8 |
| v2.2 (12) | `settings.automation.composerCreateAnother` | boolean | `false` | E8 |
| v2.2 (12) | `workspaces[].note` | string opcional (max 140; mas largo se recorta) | ausente | E8 |
| v2.2 (12) | `workspaces[].taskState` | `'todo'|'doing'|'review'|'done'` opcional | ausente | E8 |
| v3.0 (13) | `settings.remote.phoneFit` | boolean | `true` | E3 |
| v3.0 (13) | `settings.remote.https` | `{ enabled, mode: 'tailscaleServe' }` | `{ false, 'tailscaleServe' }` | E3 |
| v3.0 (13) | `settings.cliEnabled` | boolean | `true` | E6 |
| v3.0 (13) | `settings.worktreesRoot` | string | `''` (= dataDir()/worktrees) | E6 |
| v3.0 (13) | `workspaces[].panes[].worktree` | `{ repoRoot, path, branch, base }` opcional | ausente | E6 |
| v3.0 (13) | `repoConfigTrust` (top-level) | `Record<string, string>` | `{}` | E6 |
| v3.0 (13) | `automations` (top-level) | `Automation[]` | `[]` | E6 |
| v3.0 (13) | `settings.hibernateIdleMinutes` | number (0 = off) | `0` | E6 |

v2.0 no agrega ni quita claves de config. No existe ninguna clave de retencion ni de "conservar datos legados" (el diseno anterior con rollback a 1.x se descarto), y el estado de la migracion, el vencimiento del respaldo y `noticeSeen` viven en el marcador, no en `config.json`. La retencion del zip es la constante `BACKUP_TTL_MS` (30 dias), no un ajuste. E0 solo lee claves existentes de la config migrada: `settings.launchOnStartup` (login item, FR-12), `settings.notifications.hooksEnabled` (FR-14), `settings.remote.enabled` y `settings.remote.port` (aviso de firewall y reconexion, FR-10 y FR-19) y `settings.language` (idioma de los dialogos de main).

Fuera de config.json: estado de la migracion del legado en `dataDir()/legacy-migration.json` y respaldo en `dataDir()/migration-backup-v1.zip` (E0, ver "Migracion del legado"), registro de sesiones de agentes en `dataDir()/agent-sessions.json` (E5, v2.1, main-owned, `version: 1`, no se exporta), claves VAPID en `dataDir()/push-keys.json`, runtime del CLI en `dataDir()/runtime.json`, adjuntos en `dataDir()/attachments`, scrollback en `dataDir()/scrollback`.

Claves localStorage del celu (prefijo `snagentsos.`, siempre con try/catch): `remote.deviceId`, `remote.secret`, `remote.hostPlatform` (E0; migracion unica desde `snmulticc.remote.*`: se copian, se relee para confirmar y recien entonces se borran las legadas; si la escritura falla se usan las legadas en memoria sin borrarlas, L20); `inputMode.<paneId>`, `draft.<paneId>`, `composer.autocorrect`, `composer.agentsDefault`, `alerts.inPage` (boolean, default `true`, E1-FR-40) (E1); sessionStorage `snagentsos.reloadFor` (version para la que ya se recargo el bundle, E1-FR-15); `keybar`, `lastPane`, `home.collapsed`, `fontScale`, `lastViewed` (paneId -> ms, tope 200, LRU; enmienda R22-14), `prefs` (`{ version: 1, toasts, vibrate, toastDone }`, reemplaza a `alerts.inPage`; enmienda R22-18) (E2); sessionStorage `snagentsos.diag` (E2).

### Atajos

Existentes, no reutilizar: Ctrl+K palette, Ctrl+Tab, Ctrl+PageDown, Ctrl+PageUp, Ctrl+Shift+N, Ctrl+Shift+T, Ctrl+Shift+G globalPrompt, Ctrl+, , Ctrl+Shift+B, Ctrl+Shift+Space, Ctrl+Shift+Down, Ctrl+Shift+R redraw, familia fija Alt+1..9 (workspace N), Ctrl+C/Ctrl+V/Ctrl+Shift+C/Ctrl+Shift+V, Ctrl+Enter (envia `\x1b\r`), Ctrl+Shift+F buscar, Ctrl+= / Ctrl+- / Ctrl+0 zoom, global Super+Alt+O, dev F12 y Ctrl+Shift+I. Prohibidos: Ctrl+J (nueva linea en Claude), Ctrl+R (reverse search).

| Release | Accion (id) | Atajo | Tipo | Owner |
|---|---|---|---|---|
| v2.1 | Paleta "Te esperan" | estado vacio de Ctrl+K; Ctrl+1..6 elige fila | dentro de la paleta | E4 |
| v2.1 | `nextWaiting` | Ctrl+Shift+J | remapeable | E4 |
| v2.1 | `reopenClosedPane` | Ctrl+Shift+U | remapeable | E4 |
| v2.1 | `focusNextPane` | Ctrl+Alt+Right | remapeable | E4 |
| v2.1 | `focusPrevPane` | Ctrl+Alt+Left | remapeable | E4 |
| v2.1 | Foco al pane N | Ctrl+1..9 | familia fija; useGlobalKeys la saltea si `paletteOpen` | E4 |
| v2.2 | `quickCommands` | Ctrl+Shift+Q; 1..9 dentro del popover | remapeable | E5 |
| v2.2 | `toggleChanges` | Ctrl+Shift+D | remapeable | E5 |
| v2.2 | Hunk siguiente / anterior | F7 / Shift+F7 | solo con el panel Changes enfocado | E5 |
| v2.2 | Buscar en ajustes | Ctrl+F | solo dentro del modal de ajustes | E5 |
| v2.2 | Avanzar en el wizard | Enter | solo dentro del wizard | E5 |

Ids y combinaciones de v2.1 segun D8 (gana el contrato): `reopenClosedPane` es Ctrl+Shift+U (no Ctrl+Shift+Z) y `focusNextPane`/`focusPrevPane` son Ctrl+Alt+Right/Left (no Ctrl+Shift+PageDown/PageUp, que quedan para la navegacion entre prompts de E6). El id de "siguiente que espera" es `nextWaiting` (el plan de R21-05 lo llama `nextAttention`). Ctrl+1..9 respeta `settings.agents.ctrlDigitFocus` y no actua dentro de campos editables.

### Ownership de piezas compartidas

| Pieza | Owner | Consumidores |
|---|---|---|
| Enriquecimiento de estado (HookServer, StatusManager, PaneStatus) | E4 v2.1 | E1, E2, E5 |
| Overlay de status en RemoteManager + `paneStatus` | E1 v2.1 | E2, E3 |
| `src/shared/agent-argv.ts` | E4 v2.1 | E1, E2, E3, E5 |
| `revealPane()` y pila de toasts desktop | E4 v2.1 | E5, E6 |
| `insertPathsIntoPane()` | E4 v2.1 | E5, E6 |
| STYLEGUIDE.md (tokens desktop y mobile) | E4 v2.1 | todos |
| Lector git en main | E5 v2.2 | E2, E3, E6 |
| Emulador headless | E5 v2.2 | E3 (phone-fit), E6 (hibernacion) |
| `QuickCommand` | E5 v2.2 | E2, E6 |
| Auth HTTP (`httpToken`) | E3 v3.0 | M10, M14 |
| `src/shared/review-notes-format.ts` | E6 v3.0 | E3 |
| `dataDir()` y migracion de nombres | E0 v2.0 | todos |
| Marcador `legacy-migration.json`, respaldo zip y nombres reservados de la migracion | E0 v2.0 | nadie mas escribe; el renderer lee por `app:legacyInfo` |
| `safeRemoveTree` / `tombstoneAndRemove` (`src/main/migration/safeRemove.ts`: no sigue reparse points, guardas de contencion) | E0 v2.0 | borrado de worktrees (`git:worktreeRemove`) |
| Claves i18n de la migracion: renderer `rebrand.*`, `legacy.banner.*`, `settings.data.backup.*`; main `legacy.running.*`, `legacy.failed.*` (con `{legacy}` / `{app}`, sin literales del nombre viejo). No existen `settings.data.legacy.*` | E0 v2.0 | - |

### Registro de enmiendas

| Tramo | Cerrada en | Enmiendas |
|---|---|---|
| v2.1 | R21-00 | `RemotePaneStatus.precise?` (adoptada); `RemotePaneInfo.resumable?` (D10); `RemoteStateSnapshot.terminalUnicode?`, `replay.exitCode?`, `RemotePaneInfo.exitCode?`; IPC `pty:restart`, `status:sessionEnd`, `agents:*`, `power:getState` y los opcionales de `PowerState`; campos desktop-only de `PaneStatus` (`detail`, `topic`, `firstPrompt`, `cacheSince`); claves `notifications.inAppWhenFocused`, `settings.agents.*` (v11), `workspaces[].agentsCollapsed`, `terminalAgentEndChip`; storage `snagentsos.alerts.inPage` y sessionStorage `snagentsos.reloadFor`; atajos segun D8; archivo `dataDir()/agent-sessions.json` |
| v2.2 | R22-01 (config) | Claves `terminalSnapshotMode`, `settings.agents.{resumeModalTimeoutSec, resumeNudge, resumeNudgeText, sidebarSort}`, `settings.automation.{defaultAgentPresetId, composerCreateAnother}`, `workspaces[].note`/`taskState`. `CONFIG_VERSION` 12 con la migracion snippets -> quickCommands. Las enmiendas v2.2 de protocolo, IPC y storage se registran con el WP que las implementa |
| v2.2 | R22-03 | IPC `app:takeRecovery` (pull, reemplaza a `app:rendererRecovered`), `app:reload`, `app:reportRenderError` y la forma `RendererDiagnostics -> string` de `app:diagnostics`. Carpeta `dataDir()/crashes` (20 JSON de hasta 16KB, nunca se suben). `src/shared/redact.ts` con `redact(text, { home?, extraSecrets? })` |
| v2.2 | R22-06 | IPC `app:openPath` lleva `OpenRequest`; `system:setExplorerMenu` toma `{ enabled, language }` y devuelve `ExplorerMenuResult`; altas `app:takePendingOpen` y `system:getExplorerMenu`. sessionStorage del desktop `snagentsos.openHandled` (ids de `OpenRequest` ya despachados, tope 20, sobrevive a una recarga). Variable de dev `SNAOS_TEST_EXPLORER_ROOT` (solo `HKCU\Software\SnAgentsOSTest-*`, para pruebas) |
| v2.2 | R22-11 | IPC `git:status` y `git:fileDiff` por clave de target (`{ key }`, `{ key, path, area, force? }`) con `GitChangesRes`/`GitDiffRes` en `src/shared/git-types.ts`; altas `git:openFile` y `git:setPanel`. Storage del desktop `snagentsos.changes.wrap` (`'1'`/`'0'`, Alt+Z del panel Changes). El atajo usa el id del contrato `toggleChanges` (E7 lo llama `openChanges`). La lista blanca de `git:openFile` es la de E7-FR-15 sin `.js .mjs .cjs .py .sh .rb .html .svg`: su app predeterminada los ejecuta (mismo criterio que E2-FR-30), asi que se muestran en la carpeta |
| v2.2 | R22-07 (headless) | IPC `pty:setEngine` (`TerminalEngineSettings`, `shellIntegration` opcional hasta R31-01); `PtyReattachRes.cols`/`rows`/`shellKind` obligatorios; `AppMetrics.headless?`. Sin cambios en la forma de `replay` ni en `PROTOCOL_VERSION` |
| v2.2 | R22-12 | D1 tal como quedo: el modo `argv` es la variable `SNAOS_INITIAL_PROMPT` de E2-FR-11 (main la setea con `sanitizeInitialPrompt` y `appendPromptRef` agrega ` $env:SNAOS_INITIAL_PROMPT` / ` "$SNAOS_INITIAL_PROMPT"` / ` "%SNAOS_INITIAL_PROMPT%"`), con las reglas de `initialPromptFallback` (`src/shared/initialPrompt.ts`, `shellKind.ts`); un prompt multilinea va siempre por el gate. `PtySpawnReq.launchKind` y `PtySpawnReq.initialPrompt` = `{ text, enter, mode?: 'auto' \| 'argvOnly' }` (`argvOnly`: nunca cae al gate, emite `not_delivered`; para el fallback al composer del celu). `PtySubmitReq.paneId?`. IPC `pty:submit` y `pty:promptResult`. `ctlAck.error` de `runQuickCommand`: `bad_request`, `not_found`, `not_running`, `multiline_unsafe`, `no_preset`. Snapshot `quickCommands` reemplaza a `snippets`; la tecla `snippets` de la KeyBar pasa a id `quick`. `PtySpawnReq.workspaceId` queda para el CLI (R30-11) |
| v2.2 | R22-13 | IPC `fs:dirExists` (`string -> boolean`). Store del renderer: `wizardOpen` pasa a ser el flujo completo de nuevo workspace, `composerOpen` dice cual superficie se ve (composer o wizard de 3 pasos) y `wizardDraft` precarga el wizard desde "Avanzado..."; `setWizardOpen(true, prefill?)` abre el composer (tambien desde "Abrir en SnAgentsOS"). `WorkspaceDraft.firstPrompt` va a `pendingPrompts` de la primera consola que no es shell con `source: 'composer'`. La nota se normaliza en `src/shared/workspaceNote.ts` (saltos de linea y controles a espacios, recorte a 140 sin partir un par sustituto) |
| v2.2 | R22-14 | Snapshot `presets` (`RemotePresetInfo`), `hostName` (main lo inyecta en `overlayRunning`) y `mountedWorkspaceIds` (claves `'full'` de `mountedWorkspaces`, D4). ctl `createPane.prompt` (<= 16384; el executor predice el fallback de E2-FR-11 y encola el prompt con `mode: 'argvOnly'`, el `PendingPrompt` de R22-12 suma `mode?` y `source: 'remote'`), `mountWorkspace { workspaceId }` (ack `info` = consolas), `revealPane { paneId }` y `openUrl { url }` (http, https, mailto, <= 2048; error `denied_url`). `ctlAck.promptFallback?` y `RemoteCommandResult.promptFallback?`. `switchWorkspace` del celu tambien trae la ventana al frente (solo lo usa "Mostrar en la PC" del workspace). IPC `window:reveal` (send, `src/main/window/revealWindow.ts`). Storage del celu `snagentsos.lastViewed`. No se crea `initialArgs.ts`: el prompt viaja por `pendingPrompts` (D1) |
| v2.2 | R22-15 | Sin mensajes WS nuevos: las tarjetas responden por `input`. `PtySink.onUserInput?(ptyId, paneId, data)` (opcional; `PtyManager.write` lo llama antes de escribir). La invalidacion de E2-FR-48 tambien ignora las respuestas automaticas del terminal (CPR y DECXCPR, DA, DSR, DECRPM, DECRQSS, flags kitty, OSC con BEL o ST), no solo foco y mouse. Un pedido real que promueve un `fallback:<reason>` ya invalidado hereda la marca (y su `requestAt`). `src/shared/askAnswerKeys.ts` agrega `KEY_NEXT` (flecha derecha), `KEY_ENTER` y `KEY_SUBMIT` ("1") a las constantes. localStorage del celu: `snagentsos.promptCards` (`'0'` = apagado; ausente = prendido), dentro de `MobilePrefs.promptCards`. |
| v2.2 | R22-18 | C->S `visibility { visible: boolean }` (aditivo, sin tocar `PROTOCOL_VERSION`; el celu lo manda al autenticar y en cada `visibilitychange`; `SessionManager.isPaneViewed` = autenticada, suscrita, visible y con trafico en los ultimos 30s). `remote-devices.json` suma `lastHost?`/`lastHostAt?` (zod optional; se persiste cuando cambia, nunca loopback) y `RemoteServerHandlers.onSocket(ws, ip, host)`. `StatusHealth.ntfy?` (misma forma que `discord`). `status:ntfyTest` no recibe payload: publica con la config que main ya tiene (la empuja `status:setConfig`). Storage del celu `snagentsos.prefs` `{ version: 1, toasts, vibrate, toastDone }` (se conservan claves ajenas, p. ej. `promptCards`); reemplaza a `snagentsos.alerts.inPage`, que se lee una vez como default de `toasts` y se borra al guardar. D9: `ToastStack` reemplaza a `LiveToasts` y a `inPageAlerts.ts` (borrado); en Home no hay toast, solo vibracion |
| v2.2 | R22-20 | ctl `agentResume { workspaceId, paneId, mode }` y snapshot `RemotePaneInfo.agentEnded?: { canResume }` (la marca de sesion terminada que consume la franja del celu). El desktop y el celu toman la oferta por el mismo camino (`src/renderer/lib/agentEndRun.ts`, `runAgentEnd`): la primera accion borra `agentEnded[paneId]` en forma sincronica y las siguientes reciben `stale`. Si la accion llega antes de los 800 ms del chip, la escritura espera ese resto. Sin pty viva la oferta se descarta (`not_running`). En el celu la franja se oculta localmente con [Ocultar], con la accion aceptada o con una tecla mandada desde ese celu. Un pane sin terminal montada toma el cd del shell por defecto configurado. Sin cambio de schema ni de `PROTOCOL_VERSION` |
