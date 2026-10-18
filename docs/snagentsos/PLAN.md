# Plan de implementacion SnAgentsOS

Fecha: 2026-10-17. Base: `4c521f9` (SnMultiCC 1.14.1, config v10, `PROTOCOL_VERSION = 1`).
Fuentes: PRD de los epics E0 a E8, la seccion "Contratos compartidos" y la sintesis aprobada. Tambien se revisaron `package.json`, `.github/workflows/{ci,release}.yml`, `electron-builder.yml`, `scripts/*` y las notas de memoria `release-workflow-midbuild-appearance`, `runtime-testing-singleinstance-gotcha` y `auto-update-feature`.
Revision 2026-10-18: v2.0.0 adopta la decision final del usuario sobre E0 ("todo automatico: migrar todo SnMultiCC y borrar lo viejo"). Cambian R20-02, R20-04, R20-05, R20-06, R20-09, R20-10 y R20-11, se retira R21-16 (E0-FR-11 retirado), se agregan E0-FR-27..36 a la matriz y los riesgos 20-23, y el rollback a 1.x deja de estar soportado.
Revision de completitud: cada FR de los PRD tiene un WP asignado, el orden de releases y de merges respeta todas las dependencias, y cada item de la sintesis aprobada tiene su FR (ver "Matriz de cobertura").

Reglas del plan:
- Si este plan contradice "Contratos compartidos", gana la seccion de contratos. Las divergencias de un PRD que hagan falta de verdad se listan como enmiendas, y cada una se cierra antes de empezar el WP que la usa.
- Un solo bump de `CONFIG_VERSION` por release, y lo hace el primer WP de esa release. Todo WP que consume claves nuevas de la release puede desarrollarse en paralelo, pero mergea despues del WP de schema.
- Ningun WP se agenda ni se mergea antes de otro del que dependa.
- Prohibidos el em dash y el en dash en codigo, UI, docs, commits y notas de release.

### Correspondencia de owners del contrato con los epics de los PRD

"Contratos compartidos" usa una numeracion previa (E4 = desktop v2.1, E5 = desktop v2.2, E6 = desktop v3.0). Los PRD finales numeran por tema. Este plan usa los epics de los PRD:

| Owner en el contrato | Epic real del PRD |
|---|---|
| E4 v2.1: enriquecimiento de estado, `agent-argv.ts`, `revealPane()`, toasts, `insertPathsIntoPane()`, STYLEGUIDE | E4 (pila de toasts, STYLEGUIDE, FR-09) + E5 (resume, `restartPane.resume`, PC despierta) + E7 (drop) |
| E5 v2.2: update, explorer, scrollback, lector git, emulador headless, `QuickCommand` | E4 (update, explorer, resiliencia) + E6 (headless, scrollback) + E7 (git) + E8 (Quick Commands) |
| E6 v3.0: CLI, `.snagentsos.json`, worktrees, `review-notes-format.ts`, automations, hibernacion | E8 (CLI, repo config, automatizaciones) + E7 (worktrees, notas) + E5 (hibernacion) |

## Resumen de releases

| Version | Tema | Epics / FR incluidos | Criterio de salida |
|---|---|---|---|
| **v2.0.0** | Rebrand a SnAgentsOS (sale solo, primero) con migracion y limpieza automaticas de SnMultiCC | E0-FR-01..36 menos FR-11 (retirado: lo reemplaza la limpieza automatica de FR-27..36; ya no hay contingencia R21-16). `CONFIG_VERSION` sigue en 10 | `npm test` (con `test-rebrand` y `check-brand`) en verde en los 3 OS. En VM Windows 10 y 11, cada W cierra con el chequeo **"sin restos"** del plan de pruebas de E0 (no queda ningun artefacto L01-L18 de su modo; quedan solo `migration-backup-v1.zip`, el marcador en `done` y las excepciones L19/L21 o `skipped: needsElevation` con su accion en el aviso). Aprobados: W1 (setup sobre 1.14.1 abierta: app en `Programs\SnAgentsOS`, sin `Programs\SnMultiCC`, una sola entrada en Aplicaciones, resultado del pin registrado), W3 (portable renombrada a `SnAgentsOS-portable.exe`, sin `snmulticc-data`), W4 y W20 (1.x abierta), W5 (el celu reconecta sin QR), W10 (crash a mitad de la limpieza reanuda), W15 (archivo bloqueado queda `deferred` y termina), W16 (falla de verificacion no borra nada), W17 (vencimiento del zip), W18 (per-machine), W19 (portable dentro de la carpeta de instalacion) y W14 (ensayo del release en draft). Repo renombrado y 301 validado (W0). Release publicado con 16 assets `SnAgentsOS-*`/`snagentsos_*` sin ventana de draft visible. W12: update real desde la 1.14.1 instalada y la portable, los dos **sin restos** |
| **v2.1.0** | El celu sabe quien te necesita + agentes durables | E1 (M1-M5): FR-01..07, 10..41; FR-09 adelantado en R21-02; FR-02 lo cumple E4-FR-09; FR-08 queda en v2.2. E4-FR-01..11. E5-FR-01, 02, 04..11, 14..20, 23, 24, 29. E6-FR-05 (via modos), 14..23, 32..34, 38. E7-FR-01..03. Schema 11 | Todos los P0 con sus AC. Checklist de mojibake firmado (Unicode11 + Canvas). Celu iOS y Android por LAN y por Tailscale con estado, composer, KeyBar y tabs. Retomar un Claude real despues de quit, update y reinicio de Windows. Update 2.0.0 -> 2.1.0 probado. 16 assets |
| **v2.2.0** | Home y respuestas con un tap + comodidad desktop | E1-FR-08. E2 completo (M6-M9, ntfy, KeyBar 2). E4-FR-12..37. E5-FR-03, 12, 13, 21, 22. E6-FR-01..13, 24, 35..37. E7-FR-04..16. E8-FR-01..10. Schema 12 (migracion real snippets -> quickCommands) | Migracion v11 -> v12 sin perdida (snippets preservados). Tarjetas de permiso y de pregunta probadas con Claude 2.1.x real. Bench headless dentro de presupuesto (si no, default `lazy`). Scrollback restaurado despues de cerrar con la X, desde el tray, por el instalador y al apagar. Crash del renderer recuperado sin matar ptys. Update 2.1 -> 2.2 con tarjeta y chip. 16 assets |
| **v3.0.0** | El celu como herramienta de trabajo + automatizacion y git pesado | E3 completo (M10-M14 y Changes mobile; FR-11/35/41/51 retirados en el PRD). E5-FR-25..28. E7-FR-17..36. E8-FR-12..31 y la parte desktop de FR-32. Schema 13. `PROTOCOL_VERSION` sigue en 1 | Phone-fit sin oscilacion con 2 celus. Chat con Claude real. Imagen subida por HTTP con Bearer. HTTPS por `tailscale serve` + Web Push en la PWA de iOS. CLI `snaos` probado en PowerShell 5.1, pwsh y cmd. `.snagentsos.json` con trust por hash. Crear y borrar un worktree sin tocar el `node_modules` original. Update 2.2 -> 3.0. 16 assets |
| **v3.1.0** | Pendientes aprobados "mas adelante" | E6-FR-25..31 (shell integration de PowerShell). E8-FR-11, la parte de celu de E8-FR-19 y la parte de celu de E8-FR-32. M7 extras: "Permitir siempre" y tarjeta de Plan (FR nuevos E2-FR-53/54, a redactar). Carrera etapas B/C si v3.0 se atrasa. Schema 14 | Marcas OSC 133 y UTF-8 sin BOM en PowerShell 5.1 y pwsh con el perfil real del usuario. Nota, statusLine y automatizaciones visibles en el celu. Tarjetas extra de M7 probadas con Claude real. Update 3.0 -> 3.1. 16 assets |
| **v3.x (sin agendar)** | Backlog fuera de la sintesis | E3 `manualCert`. Chip de fin para Codex. `precise`/`serverTime` si no se aprobaron en v2.1. Sincronizacion de notas entre celu y desktop. `RemotePaneInfo.local`. `gitReq.paneId` | Cada item entra cuando tiene FR y sus campos estan dados de alta en Contratos compartidos |

## Matriz de cobertura

**FR por epic -> WP**

| Epic | FR -> WP |
|---|---|
| E0 | 01, 03, 04, 17 -> R20-01. 02, 15 -> R20-02. 05, 13, 14 (funcion) -> R20-03. 07, 08, 09, 12, 14 (orquestacion), 26, 27, 28 (zip y vencimiento), 29, 30, 31, 32, 33, 34, 35 (log y estado), 36 -> R20-04. 10, 28 (linea de Ajustes > Datos), 35 (banners) -> R20-05. 06, 25 -> R20-06 (33: `portableExeFile()` sin cache, coordinado con R20-04). 18, 19 -> R20-07. 21, 24 (publicacion) -> R20-08. 22, 23, 24 (contenido) -> R20-09. 16 -> R20-10 + R20-11. 20 -> R20-11. 11: retirado (reemplazado por 27..36; la contingencia R21-16 tambien queda retirada) |
| E1 | 01 -> R21-02. 02 -> cumplido por E4-FR-09 en R21-02. 03..07, 40 -> R21-10. 08 -> R22-09. 09 -> R21-02. 10..15, 41 -> R21-11. 16..21 -> R21-12. 22..31, 38 -> R21-13. 32..37, 39 -> R21-14 |
| E2 | 01..16, 47, 49..51 -> R22-14. 17..25, 48 -> R22-15. 26..34 -> R22-16. 35..39 -> R22-17. 40..44, 52 -> R22-18. 45, 46 -> R22-19. 53, 54 (propuestos) -> R31-03 |
| E3 | 01..05 -> R30-02. 06..10 -> R30-03. 12..20, 22, 23 -> R30-04. 21, 24..34 -> R30-05. 36..40 -> R30-06. 42..50 -> R30-07. 52..56 -> R30-09b. 11, 35, 41, 51: retirados en el PRD |
| E4 | 01, 02 -> R21-00. 03..08 -> R21-04. 09 -> R21-02. 10, 11 -> R21-05. 12..18 -> R22-04. 19..25 -> R22-03. 26..31 -> R22-05. 32..35 -> R22-06. 36, 37 -> R22-02 |
| E5 | 01, 02 -> R21-02. 04 -> R21-04. 05..10, 14 -> R21-03. 11 -> R21-03 (contrato y executor) + R21-14 (UI mobile). 15..20 -> R21-05. 23, 24 -> R21-06. 29 -> R21-05 + R21-06. 03, 12, 13, 21, 22 -> R22-09. 25..28 -> R30-14 |
| E6 | 05, 14..16, 32..34 -> R21-07. 17..23, 38 -> R21-08. 01..07, 35 -> R22-07. 08..13, 36, 37 -> R22-08. 24 -> R22-20. 25..31 -> R31-01 |
| E7 | 01..03 -> R21-09. 05..10 -> R22-10. 04, 11..16 -> R22-11. 17..21 -> R30-08. 22..26 -> R30-09a. 27..32, 36 -> R30-10. 33..35 -> R30-15 |
| E8 | 01 -> R22-01. 02..07 -> R22-12. 08..10 -> R22-13. 12..22 -> R30-11. 23..27 -> R30-12. 28..31, 32 (desktop) -> R30-13. 11, 19 (celu), 32 (celu) -> R31-02 |

**Sintesis aprobada -> FR**

| Item | FR |
|---|---|
| M1 estado del agente | E1-FR-01..09, 40 (datos: E4-FR-09) |
| M2 conexion confiable | E1-FR-10..15, 41 |
| M3 KeyBar parte 1 | E1-FR-16..21 |
| M4 composer | E1-FR-22..31, 38 |
| M5 tabs + Sheet + Back | E1-FR-32..37, 39 |
| M6 Home real | E2-FR-01..16, 47, 49..51 |
| M7 tarjetas | E2-FR-17..25, 48. Diferidos "Permitir siempre" y tarjeta de Plan: E2-FR-53/54 propuestos (R31-03) |
| M8 texto usable | E2-FR-26..34 |
| M9 diagnostico + firewall | E2-FR-35..39 |
| Notificaciones (toast en pagina, ntfy, solo ausente, deep links) | E1-FR-40, E2-FR-40..44, 52 |
| KeyBar parte 2 | E2-FR-45, 46 |
| M10 imagen | E3-FR-06..10 |
| M11 phone-fit | E3-FR-12..23 |
| M12 Chat | E3-FR-24..34 |
| M13 historial | E3-FR-36..40 |
| M14 HTTPS + push | E3-FR-42..50 |
| Changes mobile | E3-FR-52..56 (backend E7-FR-22..26) |
| Idea 1 tarjeta de update | E4-FR-12..18, 37 |
| Idea 2 toasts | E4-FR-03..08 |
| Idea 3 resiliencia | E4-FR-19..25, 36 |
| Idea 4 pulido | E4-FR-01, 02, 10, 11, 26..31 |
| Idea 5 Abrir en SnAgentsOS | E4-FR-32..35 |
| Idea 6 retomar | E5-FR-05..14 |
| Idea 7 paleta Te esperan | E5-FR-04, 15..18 |
| Idea 8 filas por agente | E5-FR-01..03, 19..22 |
| Idea 9 PC despierta | E5-FR-23, 24 |
| Idea 10 headless | E6-FR-01..07, 33, 35 |
| Idea 11 scrollback | E6-FR-08..13, 36, 37 |
| Idea 12 detalles chicos | E6-FR-14..24, 32, 34, 38 |
| Idea 13 chip git + Changes | E7-FR-05..16 |
| Idea 14 notas de revision | E7-FR-17..26 |
| Idea 15 soltar imagen | E7-FR-01..04 |
| Idea 16 worktree + carrera | E7-FR-27..36 |
| Idea 17 Quick Commands | E8-FR-01..07 |
| Idea 18 CLI + skill | E8-FR-12..22 |
| Idea 19 `.snagentsos.json` | E8-FR-23..27 |
| Mas adelante: automatizaciones recurrentes | E8-FR-28..32 |
| Mas adelante: hibernacion | E5-FR-25, 26 |
| Mas adelante: composer de workspace | E8-FR-08, 09 |
| Mas adelante: nota y estado por workspace | E8-FR-10, 11, 20 |
| Mas adelante: tablero de agentes | E5-FR-27 |
| Mas adelante: shell integration PowerShell | E6-FR-25..31 |
| Mas adelante: timer del cache | E5-FR-28 |
| Licencia (THIRD_PARTY_NOTICES, headers MIT) | R21-00 (o E0 si porta codigo) + header por archivo en cada WP |

## Grafo de dependencias

```mermaid
flowchart LR
  subgraph V20["v2.0.0 Rebrand"]
    R20_01[R20-01 brand.ts y cadenas] --> R20_02[R20-02 Empaquetado y NSIS]
    R20_01 --> R20_03[R20-03 Env, launcher y hooks]
    R20_01 --> R20_06[R20-06 Updater]
    R20_01 --> R20_07[R20-07 Mobile titulos y auth]
    R20_01 --> R20_08[R20-08 CI draft y 16 assets]
    R20_03 --> R20_04[R20-04 Migracion, verificacion, zip, limpieza y dev aislado]
    R20_02 -.LegacyInstallLocation y LegacyTaskbarPinned.-> R20_04
    R20_06 -.portableExeFile.-> R20_04
    R20_04 --> R20_05[R20-05 Aviso, banners y linea del respaldo]
    R20_02 & R20_05 & R20_06 & R20_07 & R20_08 --> R20_09[R20-09 Docs, notas, check-brand]
    R20_09 --> R20_10[R20-10 Validacion W1-W20 y merge]
    R20_10 --> R20_11[R20-11 Rename repo, W0, tag v2.0.0]
  end
  subgraph V21["v2.1.0"]
    R21_00[R21-00 STYLEGUIDE, CLAUDE.md, NOTICES]
    R21_01[R21-01 Schema 11 y primitivas de store]
    R21_01 --> R21_02[R21-02 Enriquecimiento de estado]
    R21_02 --> R21_03[R21-03 agent-argv y retomar]
    R21_00 & R21_02 --> R21_04[R21-04 Toasts, revealPane, aviso in-app]
    R21_03 & R21_04 --> R21_05[R21-05 Paleta, atajos, filas del sidebar]
    R21_02 --> R21_06[R21-06 PC despierta]
    R21_01 --> R21_07[R21-07 ModeTracker, exit, Unicode11, shell]
    R21_07 & R21_03 --> R21_08[R21-08 Tarjeta de salida y chip Claude termino]
    R21_09[R21-09 Drop de archivos]
    R21_00 & R21_02 --> R21_10[R21-10 M1 estado en el celu]
    R21_11[R21-11 M2 conexion]
    R21_12[R21-12 M3 KeyBar]
    R21_10 & R21_11 & R21_12 --> R21_13[R21-13 M4 composer]
    R21_10 & R21_03 --> R21_14[R21-14 M5 tabs, Sheet, Back]
  end
  R20_11 --> R21_00 & R21_01 & R21_09 & R21_11 & R21_12
  subgraph V22["v2.2.0"]
    R22_01[R22-01 Schema 12 y QuickCommand]
    R22_02[R22-02 Ciclo de vida pty y update en main]
    R22_02 --> R22_03[R22-03 Resiliencia]
    R22_02 --> R22_04[R22-04 Tarjeta update y chip]
    R22_05[R22-05 Busqueda ajustes, KeyHint, wizard]
    R22_05 --> R22_06[R22-06 Abrir en SnAgentsOS]
    R22_02 --> R22_07[R22-07 Headless mirror]
    R22_07 --> R22_08[R22-08 Scrollback persistido]
    R22_09[R22-09 Modal retomar, nudge, Smart, Codex]
    R22_10[R22-10 GitService y chip] --> R22_11[R22-11 Panel Changes]
    R22_01 --> R22_12[R22-12 Quick Commands y entrega]
    R22_12 & R22_05 --> R22_13[R22-13 Composer de workspace y nota]
    R22_12 --> R22_14[R22-14 M6 Home]
    R22_10 -.chip git.-> R22_14
    R22_14 --> R22_15[R22-15 M7 tarjetas]
    R22_16[R22-16 M8 texto usable]
    R22_03 -.redact.ts.-> R22_17[R22-17 M9 diagnostico y firewall]
    R22_14 -.SettingsScreen.-> R22_17
    R22_14 & R22_01 --> R22_18[R22-18 ntfy, ausencia, deep links]
    R22_19[R22-19 KeyBar parte 2]
    R22_14 -.SettingsScreen.-> R22_19
    R22_14 & R22_01 --> R22_20[R22-20 Espejo mobile del chip Claude termino]
    R22_01 --> R22_04 & R22_06 & R22_07 & R22_08 & R22_09 & R22_10
    R22_04 -.updater.ts.-> R22_08
  end
  R21_08 --> R22_02
  R21_08 --> R22_20
  R21_03 & R21_05 --> R22_09
  R21_13 & R21_14 --> R22_14
  R21_12 --> R22_19
  R21_03 --> R22_12
  subgraph V30["v3.0.0"]
    R30_01[R30-01 Schema 13]
    R30_01 --> R30_02[R30-02 httpToken, rate, safePaste]
    R30_02 --> R30_03[R30-03 Imagen desde el celu]
    R30_04[R30-04 Phone-fit]
    R30_04 --> R30_05[R30-05 Vista Chat]
    R30_06[R30-06 Historial y retomar]
    R30_02 --> R30_04 & R30_05 & R30_06
    R30_02 --> R30_07[R30-07 HTTPS, SW, Web Push]
    R30_08[R30-08 Notas de revision desktop] --> R30_09a[R30-09a API git remota]
    R30_02 --> R30_09a
    R30_09a --> R30_09b[R30-09b Changes mobile]
    R30_10[R30-10 Worktrees] --> R30_15[R30-15 Carrera]
    R30_01 --> R30_04 & R30_10
    R30_01 --> R30_11[R30-11 CLI snaos y skill]
    R30_01 --> R30_12[R30-12 .snagentsos.json]
    R30_01 --> R30_13[R30-13 Automatizaciones recurrentes]
    R30_01 --> R30_14[R30-14 Hibernacion, tablero, cache timer]
    R30_13 -.usePaneScheduler.-> R30_14
    R30_05 -.chatSub visibilidad.-> R30_07
  end
  R22_07 --> R30_04
  R22_15 --> R30_05
  R21_03 --> R30_06
  R22_11 --> R30_08
  R22_10 & R22_02 --> R30_10
  R22_12 --> R30_11 & R30_12 & R30_13 & R30_15
  R22_13 --> R30_12
  R22_02 & R22_09 --> R30_14
  R22_18 --> R30_07
  subgraph V31["v3.1.0"]
    R31_00[R31-00 Schema 14 y enmiendas v3.1]
    R31_00 --> R31_01[R31-01 Shell integration PowerShell]
    R31_00 --> R31_02[R31-02 Nota, statusLine y automatizaciones en el celu]
    R31_00 --> R31_03[R31-03 M7 extras: Permitir siempre y Plan]
  end
  R30_16[R30-16 Release v3.0.0] --> R31_00
  R30_11 & R30_13 --> R31_02
  R22_15 --> R31_03
```

### Decisiones de integracion entre epics (vinculantes para los WP)

- **D1. Prompt inicial unico.** En v2.2 hay dos mecanismos: E2-FR-11 (variable `SNAOS_INITIAL_PROMPT`) y E8-FR-02b (argv entre comillas simples + gate). Se unifican en `src/shared/agent-argv.ts` + `src/shared/initialPrompt.ts`, que crea R22-12:
  - El modo directo usa la variable de entorno de E2 con sus reglas de saneo y fallback, porque es mas segura con shims `.cmd` y con `%`.
  - El fallback del desktop (Quick Commands, composer, CLI, repo, automatizaciones) es el gate de E8: Enter solo ante una senal precisa.
  - El fallback del celu (`createPane.prompt`) es el draft del composer de E2.
  - `buildAgentArgv` sigue siendo el unico constructor de argv. Ahi tambien viven `stripForResume`, `isSafeSessionId` y `buildCdPrefix` (E5/E6). No se crean `agentResume.ts` ni `agentPrompt.ts` aparte.
- **D2. Retomar pasa por el reinicio en el lugar.** `PTY_RESTART` (E6) recibe el `PtySpawnReq` completo, asi que "Reiniciar retomando" (E5) arma el argv con `buildAgentArgv` y lo pasa por el mismo camino que conserva el scrollback.
- **D3. El unmount nunca mata (E4-FR-36, v2.2).** La hibernacion de E5 (v3.0) llama a `killPanePtys` de forma explicita y no depende del cleanup de `useXterm`.
- **D4. Una sola primitiva de montaje.** `mountedWorkspaces: Record<wsId, 'full' | string[]>` + `ensureMounted(id, {only?})` (la forma de E8). Nace en R21-01. La consumen E5 (auto-retomar interrumpidos), E2 (`mountWorkspace`; `mountedWorkspaceIds` del snapshot = claves en `'full'`) y E8 (montaje parcial).
- **D5. Fuente de verdad de la sesion.** `dataDir()/agent-sessions.json` (main). `pane.lastSession` es un espejo que escribe el renderer y la semilla de recuperacion.
- **D6. Nombres de canal git.** E7 adopta los nombres del contrato: `git:setWatch` (antes `setTargets`), `git:update` (antes `summary`), `git:status` (antes `changes`), `git:fileDiff` (antes `diff`), `git:worktreeAdd`/`git:worktreeRemove`. `git:info`, `git:openFile`, `git:setConfig`, `git:refresh`, `git:worktreeInspect` y `git:worktreeList` se dan de alta como enmienda.
- **D7. `build/installer.nsh` es un solo archivo compartido por tres epics.** E0 (v2.0) aporta `customInit` (solo con `/S`), `customPageAfterChangeDir` (pagina oculta) y `customInstall`, mas sus auxiliares `snPrepareUpgrade`, `snGuardPortableData` y el LangString `snPortableDataInside`. E4 (v2.2) agrega `customUnInstall` y E8 (v3.0) `customUnInit`. Cada WP agrega su macro sin tocar las otras, y `test-rebrand.cjs` verifica que sigan todas las macros, que no haya `/T`, que se lea con `SHCTX` y que cada `nsExec::Exec` vaya seguido de `Pop`.
- **D8. Atajos: gana el contrato.** `reopenClosedPane` = Ctrl+Shift+U (no el Ctrl+Shift+Z de E5). `focusNextPane`/`focusPrevPane` = Ctrl+Alt+Right/Left (no el Ctrl+Shift+PgDn/PgUp de E5), remapeables por el riesgo de AltGr y de la rotacion de Intel. Asi Ctrl+Shift+PageUp/PageDown quedan libres para la navegacion entre prompts de E6 (v3.1). `agentsBoard` = Ctrl+Shift+A se da de alta como enmienda para v3.0.
- **D9. Toast del celu.** E1-FR-40 (v2.1) usa el Toast actual. E2-FR-43 (v2.2) lo reemplaza por `ToastStack` y reusa la logica de `inPageAlerts`.
- **D10. Visibilidad de las acciones de retomar en el celu.** Se adopta en v2.1 la enmienda `RemotePaneInfo.resumable?: boolean` (riesgo 23 de E1). E2-FR-49 la usa en lugar de inferir por provider.
- **D11. PasteSheet no existe desde v2.1.** E1-FR-31 (R21-13) lo elimina. Todo FR posterior que nombra PasteSheet (E3-FR-05, E3-FR-48) usa el composer en modo one-shot como destino y como fallback (enmienda de v3.0).
- **D12. Owner de lastMessage para Codex.** E1-FR-08 (agentMessage de Codex como `lastMessage`) lo implementa R22-09 junto con E5-FR-03, sobre el mismo listener del App Server.

## Releases en detalle

### Procedimientos comunes (todos los WP los referencian)

**P-WT: trabajo en paralelo sin mover el arbol compartido.** El repo lo editan varias consolas a la vez. Cada WP se trabaja en su propio worktree, nunca con `git checkout -b` en el arbol comun:
```powershell
git fetch origin
git worktree add ..\snaos-wt\<wp> -b <rama> origin/main   # en v2.0, desde la rama de integracion
cd ..\snaos-wt\<wp>; npm ci
# ... trabajo y commits ...
git push -u origin <rama>; gh pr create --base main --fill
git worktree remove ..\snaos-wt\<wp>
```

**P-DESK: runtime aislado (gotcha de instancia unica).** No se toca la app instalada del usuario ni sus consolas:
```powershell
Remove-Item Env:ELECTRON_RENDERER_URL -ErrorAction SilentlyContinue
npm run build
$p = "$env:TEMP\snaos-<wp>"; New-Item -ItemType Directory -Force $p | Out-Null
$env:CLAUDE_CONFIG_DIR = "$p\claude"    # los hooks nunca tocan ~/.claude real
$env:CODEX_HOME = "$p\codex"            # opcional, cuando se prueba Codex aislado
node_modules\electron\dist\electron.exe out\main\index.js --user-data-dir=$p
# al terminar: taskkill /PID <pid> /T /F ; Remove-Item -Recurse -Force $p
```
- En el perfil aislado, el puerto remoto tiene que ser distinto del de la app real: precargar `config.json` con `settings.remote.port = 4518`.
- Si el puerto de hooks choca con la app instalada, la prueba de hooks se hace con esa app cerrada o en una VM.
- Desde v2.0, dev sin `--user-data-dir` usa `%APPDATA%\snagentsos-dev` (E0-FR-26). Igual se sigue usando `--user-data-dir` para tener un perfil desechable.
- Toda escritura de archivos de texto desde PowerShell usa `WriteAllText` con UTF-8 sin BOM (CLAUDE.md global).

**P-LEGACY: migracion y limpieza sin tocar datos reales.** Desde v2.0 la limpieza borra de verdad, asi que esta regla es bloqueante. Para pruebas de dev:
```powershell
$f = "$env:TEMP\snaos-fake"                     # arbol falso: appdata\snmulticc (fixture), localappdata, temp, home
$env:APPDATA = "$f\appdata"; $env:LOCALAPPDATA = "$f\localappdata"
$env:TEMP = "$f\temp"; $env:TMP = "$f\temp"; $env:USERPROFILE = "$f\home"
$env:SNAOS_FORCE_LEGACY_MIGRATION = '1'
$env:SNAOS_FORCE_LEGACY_CLEANUP = '1'           # solo con TODAS las variables de arriba apuntando al arbol falso
```
- Despues se lanza P-DESK. Sin `SNAOS_FORCE_LEGACY_CLEANUP`, la limpieza en dev es simulacion (solo log, E0-FR-30).
- Nunca abrir un build empaquetado (`release\2.0.0\win-unpacked\SnAgentsOS.exe`, el setup o la portable) en la maquina del desarrollador: es `app.isPackaged`, migra y borra el `%APPDATA%\snmulticc` real y la 1.14.1 instalada (E0 R16).
- Los escenarios con instalador o con build empaquetado (W1..W4, W10..W12, W15..W20) se corren en una VM con snapshot (Windows 10 y Windows 11) o en un usuario de Windows aparte con 1.14.1 instalada. Se restaura el snapshot entre escenarios.
- Las fallas inyectadas (`SNAOS_TEST_FAULT`) solo funcionan en un build de prueba con el define `__SNAOS_TEST_FAULTS__`; ese build nunca se publica.

**P-PHONE: celu por LAN y Tailscale contra la instancia aislada.**
- Activar el control remoto en el perfil aislado (puerto 4518) y emparejar por QR. Es otro origen, asi que tiene su propio `localStorage` y el emparejamiento real en 4517 no se toca.
- Aceptar el prompt de firewall para `electron.exe` solo en red Privada.
- Probar con IP LAN (192.168.x) y con IP Tailscale (100.x), en iPhone (Safari y PWA instalada desde ese origen) y en Android Chrome.
- Al terminar, revocar el dispositivo en la instancia aislada y borrar la regla de firewall del binario de dev si se creo.

**P-NOBILL:** las pruebas con Claude/Codex reales usan `/help` o prompts triviales acordados, sin turnos largos facturables.

---

### v2.0.0: Rebrand (sale solo)

Integracion: todos los WP se hacen como PR hacia la rama `feat/rebrand-snagentsos`, creada desde `main`. Un rebrand a medias en `main` romperia `check-brand` y los nombres de assets. Al final hay un solo PR a `main`, sin tag. Schema: `CONFIG_VERSION` sigue en 10.

#### R20-01 Constantes de marca y cadenas visibles
- **Rama:** `feat/rebrand-brand-constants` (base de los demas).
- **FR:** E0-FR-01, 03, 04, 17 (titulos mobile).
- **Archivos:**
  - `src/shared/brand.ts` (nuevo).
  - `src/main/window.ts`, `src/main/index.ts` (titulo del dialogo, `defaultPath`, AUMID), `src/main/tray.ts`, `src/main/i18n.ts`.
  - `src/main/status/StatusManager.ts`, `src/main/status/DiscordNotifier.ts`.
  - `src/renderer/index.html`, `TitleBar.tsx`, `Logo.tsx`, `src/renderer/i18n/{en,es}.ts` (5 claves con `{app}`, `empty.title`, sacar `tray.show`).
  - `src/mobile/index.html`, `manifest.webmanifest`, `src/mobile/src/lib/i18n.ts`, `RemoteServer.ts:212`.
  - Comentarios de `shellResolver.ts`, `types.ts`, `ipc-contract.ts`, `useXterm.ts`.
  - Cambiar el unico en dash del repo (`src/renderer/components/ui/UsageRing.tsx`).
- **Schema:** sin cambio.
- **Tests:** `scripts/test-rebrand.cjs` (nuevo, esqueleto) con el chequeo de constantes. `tsc` detecta claves i18n faltantes.
- **Verificacion manual:** P-DESK. Ventana, TitleBar, wordmark "SnAgentsOS", las 5 claves interpoladas en es/en sin `{app}` literal, nombre sugerido de export `snagentsos-config.json`.
- **Esfuerzo:** M. **Paralelo con:** nada (es la base).

#### R20-02 Empaquetado e instalador
- **Rama:** `feat/rebrand-packaging`.
- **FR:** E0-FR-02, 15.
- **Archivos:**
  - `package.json` (name `snagentsos`, version `2.0.0`, description, `test` encadenado) y `package-lock.json` (`npm install --package-lock-only`).
  - `electron-builder.yml` (appId, productName, `nsis.guid: 8c5f793e-c93a-5e95-add6-ae90c4af8c04`, `portable.unpackDirName: SnAgentsOS`, `nsis.include: build/installer.nsh`).
  - `build/installer.nsh` (nuevo, D7): macro `snPrepareUpgrade` (lee la `InstallLocation` legada con `SHCTX`, redirige `$INSTDIR` a `<padre>\SnAgentsOS`, recuerda el pin, cierra `SnMultiCC.exe` del usuario **sin `/T`**), `snGuardPortableData` + LangString `snPortableDataInside` (aborta antes de desinstalar si hay `snmulticc-data`/`snagentsos-data` en la carpeta vieja o en el destino), `customInit` (llama a `snPrepareUpgrade` solo con `/S`), `customPageAfterChangeDir` (pagina oculta: repite el redirect y llama a `snPrepareUpgrade` cuando el usuario ya confirmo el asistente) y `customInstall` (borra `%LOCALAPPDATA%\snmulticc-updater` con `SetShellVarContext current` y escribe `LegacyInstallLocation` y `LegacyTaskbarPinned` en `SHCTX\Software\<GUID>`). El desinstalador viejo lo corre `uninstallOldVersion` con `_?=` sobre la `InstallLocation` del registro y borra `Programs\SnMultiCC`, `SnMultiCC.lnk` y las claves del GUID (E0-FR-15).
  - `src/mobile/package.json`.
- **Schema:** sin cambio.
- **Tests:** en `test-rebrand.cjs`, consistencia de `electron-builder.yml`/`package.json` con `brand.ts`, que no haya `productName` en `package.json` y, sobre `installer.nsh`: que define `customInit`, `customPageAfterChangeDir` y `customInstall`, que no escribe `InstallLocation`, que no contiene `/T`, que lee con `SHCTX` (no `HKCU` fijo) y que cada `nsExec::Exec` va seguido de `Pop`. Los nombres de valor `LegacyInstallLocation`/`LegacyTaskbarPinned` salen de una constante compartida con R20-04 (contrato).
- **Verificacion manual:** `npm run dist:win` en un worktree genera `release/2.0.0/SnAgentsOS-2.0.0-setup.exe` y `-portable.exe`. Smoke en VM (nunca en la maquina del desarrollador, P-LEGACY): setup sobre 1.14.1 con asistente deja la app en `Programs\SnAgentsOS` y sin `Programs\SnMultiCC`. W1, W2, W18, W19 y W20 completos corren en R20-10.
- **Esfuerzo:** M. **Paralelo con:** R20-03, 06, 07, 08.

#### R20-03 Entorno, launcher de Codex y hooks de Claude
- **Rama:** `feat/rebrand-env-hooks`.
- **FR:** E0-FR-05, 13, 14 (la funcion `migrateLegacyHooks`; la llamada la hace R20-04).
- **Archivos:** `PtyManager.ts:132-134`, `shellResolver.ts` (`cleanEnv` filtra `SNMULTICC_*`/`SNAOS_*` y saca `status-bin` del PATH), `CodexBridge.ts` (`findExecutable`, `environment`, `codex.cmd`), `statusRuntime.ts`, `HookInstaller.ts` (`isOurs` reconoce el mensaje viejo y el nuevo, backup `.snagentsos.bak`, `migrateLegacyHooks`), comentarios de `HookServer.ts`.
- **Schema:** sin cambio.
- **Tests:**
  - `test-status.cjs`: renombrar las variables (lineas 172, 179, 187, 188, 192, 214, 223). La prueba real de SessionStart por PowerShell valida los nombres nuevos.
  - `test-rebrand.cjs`: hooks (rewritten, notNeeded, solo SessionStart legado, `uninstallHooks`) y `cleanEnv` (`PATH`/`Path`, `SNAOS_FOO` del preset conservado).
  - Prefijo temporal en `test-status-ui.cjs:7` y `test-mobile-scroll.cjs:6`.
- **Verificacion manual:** P-DESK con un `CLAUDE_CONFIG_DIR` temporal sembrado con hooks legados. Una consola nueva tiene `$env:SNAOS_CONSOLE_ID`, no tiene `SNMULTICC_*` y el PATH no trae `snmulticc\status-bin`. `codex` reporta estado (W7).
- **Esfuerzo:** M. **Paralelo con:** R20-02, 06, 07, 08.

#### R20-04 Migracion, verificacion, respaldo, limpieza automatica y dev aislado
- **Rama:** `feat/rebrand-data-migration`.
- **FR:** E0-FR-07, 08, 09, 12, 14 (orquestacion), 26, 27, 28 (zip, verificacion y vencimiento), 29, 30, 31, 32, 33, 34, 35 (log y `app:legacyStatus`), 36.
- **Archivos:**
  - `src/main/devUserData.ts` (nuevo, primer import de `index.ts`).
  - `src/main/paths.ts` (`dataDir()`, `getLegacyDataDir()` que ignora `*.deleting-*`, `BRAND.portableDataDir`).
  - `src/main/migration/` (nuevos): `legacyMarker.ts` (marcador v2, copia `legacy-migration.prev.json`, `readMarker` con `ReadMarkerResult` ausente/ok/corrupto), `legacyBrand.ts` (`runPipeline`: detectar -> migrar -> verificar -> respaldo zip -> marcar; `snapshotCurrentConfig` con la rotacion "primera + 2 mas nuevas"), `backupZip.ts` (`writeBackupZip`/`verifyBackupZip`, writer propio con `zlib` y CRC32, grupos `other/` y `post-commit/<ISO>/`), `legacyInventory.ts` (L01-L21 con precondicion y accion), `safeRemove.ts` (`safeRemoveTree`, `tombstoneAndRemove`, `needsElevation`, `PathGuard`) y `runLegacyMigration.ts` (dialogo de FR-09 sin `/T`, login item, hooks, pin con chequeo de `Taskband\Favorites`, registro HKCU y HKLM, renombre del `.exe` portable con actualizacion de `PORTABLE_EXECUTABLE_FILE` y helper al salir, limpieza en segundo plano con reintentos de 60 s / 5 min, mantenimiento diario del zip y log `logs/legacy-migration.log`).
  - `ConfigStore.ts` (`loadLadder(dir, { readOnly: true })` puro para FR-27).
  - `DeviceRegistry.ts` (ruta y carga perezosas, `ensureLoaded` en todos los miembros, `fileSchema` exportado), `RemoteManager.ts` (`loadDevices()`).
  - `index.ts` (pipeline al inicio de `bootstrap()`, antes de `configStore.load()`; `scheduleLegacyCleanup()` despues de `openMainWindow()`), `src/main/i18n.ts` (`legacy.running.*`, `legacy.failed.*`), `electron.vite.config.ts` (define `__SNAOS_TEST_FAULTS__`, falso en el release).
- **Schema:** sin cambio (`CONFIG_VERSION` 10). Nombres reservados en `dataDir()`: `legacy-migration.json`, `legacy-migration.prev.json`, `legacy-migration.json.corrupt-*`, `.legacy-staging/`, `pre-import/`, `migration-backup-v1.zip` y `logs/legacy-migration.log`; tombstones `<legacy>.deleting-*` al lado de la carpeta vieja.
- **Orden interno de commits** (un PR, revisable por partes): marcador y `dataDir()` -> pipeline y verificacion -> zip -> `safeRemove` e inventario -> items de Windows (registro, pin, portable, residuo de instalacion) -> mac y Linux -> orquestacion y log. Hasta el ultimo commit la limpieza queda en simulacion tambien en empaquetado.
- **Tests** (`test-rebrand.cjs`, todos los casos automatizados del plan de pruebas de E0, sin el test de `targetHasData`, que ya no existe):
  - Pipeline: los 12 casos (incluidos `pre-import/` sin dialogo y la rotacion que conserva la primera instantanea, y el marcador corrupto con `prev` y `failed: markerCorrupt`).
  - Verificacion (FR-27): byte alterado, workspace faltante, secret distinto, `.bak` valido con `config.json` corrupto, todo corrupto (`legacyConfigLoadable: false`), fuente cambiada antes del commit (maximo 3 rehechos).
  - Zip (FR-28): extraccion con `tar -xf` y SHA-256 contra el manifest, byte alterado, tope de 20 MB, vencimiento con reloj inyectado (29 dias no, 30 dias + 1 min si, tambien en `cleaning`).
  - Reanudacion (FR-29): crash inyectado despues de cada transicion y del item k; crash entre el rename del tombstone y el borrado no vuelve a migrar.
  - Limpieza (FR-30..34) sobre arbol falso: snapshot antes/despues (borra exactamente L01, L12-L16 y L18), junction/symlink a una centinela externa intacta, `userData` igual/dentro/conteniendo la carpeta legada (`skipped: guard`), carpeta del exe dentro de un item, `EBUSY` permanente (`deferred` sin frenar a los demas) y bloqueo real con `FileShare.None` en Windows, solo lectura con `chmod`, `needsElevation` sin intentar borrar, `post-commit/` y `other/` (5 MB o `skipped: unknownFiles`), portable (`nameConflict`, hermano borrado, archivo en ejecucion intacto, `ownedByInstalled`), residuo de instalacion con archivo ajeno, pin vivo/huerfano/ajeno con `Favorites` simulado, modo dev sin `SNAOS_FORCE_LEGACY_CLEANUP` (nada borrado).
  - `paths`, `DeviceRegistry` (revocar como primera operacion), `devUserData` y el login item (`Run` y `StartupApproved\Run`) con `app` stub.
- **Verificacion manual:**
  - P-LEGACY con arbol falso y fixture (config, 14 backups, `remote-devices.json`, `status-bin/`, `Cache/`, un archivo desconocido, una junction a una centinela, `settings.json.snmulticc.bak`): migracion exacta, zip valido, marcador en `done`, carpeta legada borrada (solo despues de `committed`), centinela intacta. El segundo arranque no hace nada.
  - Con `config.json` en el destino y sin marcador: sin dialogo, instantanea en `pre-import/` y gana el legado.
  - W4, W15 y W20 en VM (build empaquetado, nunca en la maquina del desarrollador).
- **Esfuerzo:** XL (era L; crece por verificacion, zip, marcador v2 y motor de limpieza). **Paralelo con:** R20-06, 07, 08 (despues de R20-03). Consume la constante de valores de registro de R20-02 y `portableExeFile()` de R20-06.

#### R20-05 Aviso de bienvenida, banners y linea del respaldo
- **Rama:** `feat/rebrand-legacy-ui`.
- **FR:** E0-FR-10, 28 (linea "Respaldo de {legacy}" en Ajustes > Datos), 35 (banners). E0-FR-11 esta retirado: no hay bloque "Datos de SnMultiCC", ni botones de importar o eliminar, ni reimportacion en dos fases.
- **Archivos:** `ipc-channels.ts`/`ipc-contract.ts` (`app:legacyInfo`, `app:legacyAck`, `app:legacyShowBackup`, `app:legacyOpenLog`, evento `app:legacyStatus`, tipo `LegacyDataInfo` con `cleanup`, `backup`, `pinRetargeted`, `manualActions`, `showDeferredBanner` y `failure`), `preload/index.ts`, `src/main/ipc/registerLegacyIpc.ts` (nuevo; ninguna ruta llega desde el renderer), `rebrand/RebrandNotice.tsx` y `rebrand/LegacyBanner.tsx` (nuevos), `App.tsx`, `DataSection.tsx` (linea del respaldo con [Mostrar]), i18n `rebrand.*`, `legacy.banner.*` y `settings.data.backup.*`.
- **Schema:** sin cambio (`noticeSeen` vive en el marcador).
- **Tests:** en `test-rebrand.cjs`:
  - Verificacion negativa: no existen los canales `app:legacyImport`, `app:legacyCleanup` ni `app:legacyOpenDir`, ni claves `settings.data.legacy.*`.
  - `LegacyDataInfo` derivado del marcador: `firewallHint`, `showDeferredBanner` (item `deferred` con `cleanupStarts >= 5`), `manualActions` desde los items `skipped: needsElevation`, `backup: null` despues de `deletedAt`.
  - (La allowlist y las guardas de borrado se prueban en R20-04.)
- **Verificacion manual:**
  - P-LEGACY: el modal aparece una sola vez con los conteos, el estado de la limpieza se actualiza en vivo por `app:legacyStatus` y muestra la ruta y la fecha de vencimiento del zip. [Mostrar respaldo] abre el Explorador con el zip seleccionado. La linea de firewall aparece solo con `remote.enabled` o con devices; la de re-fijar solo con `pinRetargeted === false`; las acciones manuales solo con `needsElevation`.
  - Banner de falla (no modal) con un build de prueba `SNAOS_TEST_FAULT=verify` (W16) y [Ver registro] abre el log. Banner de restos en uso despues de 5 arranques con un item `deferred`.
  - Ajustes > Datos muestra la linea del respaldo mientras exista el zip y la saca despues del vencimiento (W17).
- **Esfuerzo:** M. **Paralelo con:** R20-06, 07, 08 (despues de R20-04).

#### R20-06 Updater
- **Rama:** `feat/rebrand-updater`.
- **FR:** E0-FR-06, 25. E0-FR-33 solo en la parte del swap (`portableExeFile()` sin cache, para no recrear el nombre viejo; el renombre lo hace R20-04).
- **Archivos:** `src/main/updater.ts` (`REPO`, User-Agent, prefijos temporales, `missing-checksum`, `pickAsset` exportado para test), i18n `update.error.missingChecksum`.
- **Schema:** sin cambio.
- **Tests:** en `test-rebrand.cjs`, `pickAsset` con los nombres reales de v2.0.0 en cada plataforma (la portable nunca elige el setup) y rechazo sin sidecar. El swap de la portable resuelve el destino con `portableExeFile()` en el momento de aplicar (sin cachear): con `PORTABLE_EXECUTABLE_FILE` cambiado a `SnAgentsOS-portable.exe` por el renombre de E0-FR-33 (R20-04), el swap escribe sobre el nombre nuevo y no recrea el viejo.
- **Verificacion manual:** con un release de prueba en un fork sin `.sha256`, la 2.0.0 local muestra el error y no ejecuta nada.
- **Esfuerzo:** S. **Paralelo con:** R20-02, 03, 07, 08.

#### R20-07 Mobile: auth y reconexion
- **Rama:** `feat/rebrand-mobile-auth`.
- **FR:** E0-FR-18, 19.
- **Archivos:** `src/mobile/src/lib/auth.ts` (migracion unica de `snmulticc.remote.*`, `storeAuth`/`clearAuth`).
- **Schema:** sin cambio.
- **Tests:** en `test-rebrand.cjs`, `auth.ts` con un `localStorage` falso: migracion, `setItem` que falla, revocacion, `unpair` y pairing nuevo.
- **Verificacion manual:** P-PHONE en una VM con 1.14.1. Celu emparejado en 1.14.1, update a 2.0.0 y reconexion sin QR al aceptar el firewall. Al recargar, el titulo es "SnAgentsOS Remote" y no quedan claves `snmulticc.remote.*` (W5).
- **Esfuerzo:** S. **Paralelo con:** R20-02, 03, 06, 08.

#### R20-08 CI: release en draft hasta 16 assets
- **Rama:** `feat/rebrand-release-ci`.
- **FR:** E0-FR-21, 24 (la publicacion de notas).
- **Archivos:** `.github/workflows/release.yml`:
  - globs `SnAgentsOS-*` / `snagentsos_*`;
  - `draft: true` en `build`;
  - `release-notes` cuenta 16 assets + un `.sha256` por distribuible y despues publica con `name: SnAgentsOS ${tag}` y `body_path` desde `docs/release-notes/<tag>.md`;
  - agregar `prerelease: ${{ contains(tag, '-') }}`, para que un tag de ensayo `v2.0.0-rc.1` nunca quede como `latest`.
- **Schema:** sin cambio.
- **Tests:** en `test-rebrand.cjs`, que `release.yml` contenga `draft: true` y el chequeo de 16.
- **Verificacion manual:** W14 por `workflow_dispatch` con un tag `v2.0.0-rc.1` desde la rama de integracion. Las 3 piernas suben al mismo draft, `latest` no cambia y se publica como prerelease. Despues se borran el release y el tag de ensayo. Si `softprops` duplica drafts, se aplica el fallback de R8 (job `prepare` + `gh release upload --clobber`).
- **Esfuerzo:** S-M. **Paralelo con:** R20-02, 03, 06, 07.

#### R20-09 Docs, notas de release y guarda de marca
- **Rama:** `feat/rebrand-docs`.
- **FR:** E0-FR-22, 23, 24 (contenido).
- **Archivos:** `README.md` (badges y seccion "Antes SnMultiCC" entre marcadores: migracion y limpieza automaticas, que se borra, `migration-backup-v1.zip` con su ubicacion, su vencimiento a los 30 dias y el procedimiento de recuperacion, firewall con la regla vieja inerte, pin segun el resultado de W1 (Q13), notas per-machine, "no guardes una portable dentro de la carpeta de instalacion", PWA de iOS, `SnMultiCC.app` a la Papelera en mac, `sudo apt remove snmulticc` en Linux y **volver a 1.x no esta soportado**), `docs/notifications-status-plan.md` (una linea), `docs/release-notes/v2.0.0.md` (nuevo), `.gitignore` (`snagentsos-data/`), `scripts/check-brand.cjs` (nuevo, con allowlist), `docs/screenshot.png` (P2).
- **Agregado del plan:** `check-brand.cjs` tambien falla ante U+2014/U+2013 en archivos trackeados, sin allowlist. Asi se cumple la regla de estilo en todos los epics siguientes.
- **Schema:** sin cambio.
- **Tests:** `npm test` = `test-status.cjs && test-rebrand.cjs && test-legacy-migration.cjs && check-brand.cjs` (R20-04 sumo `test-legacy-migration.cjs`). Un literal "SnMultiCC" plantado en `src/` hace fallar la suite.
- **Verificacion manual:** el README se renderiza en GitHub y los badges cargan despues del rename.
- **Esfuerzo:** S. **Paralelo con:** termina al final, cuando R20-02..08 ya aterrizaron en la rama de integracion.

#### R20-10 Validacion integral y merge
- **Rama:** `feat/rebrand-snagentsos` (PR a `main`).
- **FR:** todos los criterios de aceptacion de E0. E0-FR-16 (camino de update), parte previa a publicar: W1 (instalador lanzado como lo lanza el updater), W3 (swap de la portable) y W4.
- **Builds:** el setup y la portable de release (`npm run dist:win`) y, aparte, un build de prueba con `__SNAOS_TEST_FAULTS__` para W10 y W16, que nunca se publica.
- **Verificacion manual (bloqueante, P-LEGACY: VM con snapshot en Windows 10 y en Windows 11, restaurado entre escenarios).** Cada escenario cierra con el chequeo **"sin restos"** del plan de pruebas de E0 y el resultado de cada item del marcador (`done`, `absent`, `skipped` con motivo) se pega en el PR:
  - W1: setup local sin argumentos sobre 1.14.1 abierta (con `closeToTray`, consolas, hooks, Codex, `launchOnStartup`, pin y acceso directo de escritorio). App en `Programs\SnAgentsOS`, sin `Programs\SnMultiCC`, una sola entrada en Aplicaciones, el setup sobrevive al cierre de 1.14.1 (su padre). Se registra que pasa con el pin en Windows 10 y en 11.
  - W1 con el desinstalador viejo roto (valida `snPrepareUpgrade` y el aborto limpio), W1 con `/S` y W1 con una carpeta 1.x personalizada.
  - W2, W3, W4, W6..W9 y W13.
  - W10 (crash a mitad de la limpieza reanuda sin re-migrar ni otro zip), W11 (rollback no soportado documentado y recuperacion desde el zip), W15 (archivo bloqueado), W16 (falla de verificacion: nada legado cambia), W17 (vencimiento del zip), W18 (per-machine con asistente y variante "Solo para mi"), W19 (portable dentro de la carpeta de instalacion: el setup se detiene) y W20 (2.0 lanzada desde una consola 1.x sigue viva).
  - W5 con P-PHONE.
  - Con el resultado del pin de W1, ajustar el texto del README y de `docs/release-notes/v2.0.0.md` (Q13) antes del merge.
  - Si W1 falla aun con `snPrepareUpgrade`, se activa la contingencia v1.14.2 (ver "Proceso de release").
- **Esfuerzo:** M-L (tiempo de prueba: dos versiones de Windows y 20 escenarios). **Paralelo con:** nada.

#### R20-11 Rename del repo, W0 y tag
- **FR:** E0-FR-20 (rename, remote sin token, descripcion, regla de no reusar `SnMultiCC`). E0-FR-16, parte posterior a publicar: W12 (update real desde la UI de 1.14.1, instalada y portable, con SHA-256 verificado; los dos terminan con el chequeo "sin restos" de su modo y la portable queda como `SnAgentsOS-portable.exe`).
- **Pasos:** merge sin tag -> `gh repo rename SnAgentsOS -R ValentinTarnovsky/SnMultiCC --yes` -> `gh repo edit` (descripcion) -> `git remote set-url origin https://github.com/ValentinTarnovsky/SnAgentsOS.git` (sin token) -> `curl -sI .../repos/ValentinTarnovsky/SnMultiCC/releases/latest` da 301 -> W0 (la 1.14.1 dice "al dia" sin error) -> release v2.0.0 (ver "Proceso de release") -> W12.
- **Post:**
  - Actualizar las memorias `release-workflow-midbuild-appearance` (ya no hay ventana visible; sano = draft hasta 16) y `runtime-testing-singleinstance-gotcha` (dev usa `snagentsos-dev`).
  - No renombrar la carpeta local (Q4).
- **Esfuerzo:** S.

**PRs de v2.0.0:** 9 PR de WP hacia la rama de integracion (R20-01..09) y 1 PR final `chore: rebrand to SnAgentsOS` a `main`. El bump a 2.0.0 ya va dentro de R20-02.

---

### v2.1.0: El celu sabe quien te necesita + agentes durables

Arranca desde `main` con v2.0.0 publicado. El primer WP sube el schema a 11. Archivos calientes: `StatusManager.ts`, `HookServer.ts`, `PtyManager.ts`, `RemoteManager.ts` y `store.ts`. El orden de merge es R21-01 -> R21-02 -> R21-03/R21-07, y los demas rebasean.

#### R21-00 STYLEGUIDE, CLAUDE.md, notices y enmiendas de contrato v2.1
- **Rama:** `docs/styleguide-claude-md`.
- **FR:** E4-FR-01, 02.
- **Archivos:** `docs/STYLEGUIDE.md` (12 secciones, tokens de estado desktop y mobile), `CLAUDE.md` (raiz), `THIRD_PARTY_NOTICES.md` (si E0 no lo creo; tiene que existir antes de cualquier archivo portado de Orca).
- **Enmiendas al contrato v2.1** (ver Riesgos). Nota: Contratos compartidos vive en el plan maestro, no en el repo.
- **Schema:** sin cambio.
- **Tests:** `check-brand` (sin dashes).
- **Verificacion manual:** revision de lectura.
- **Esfuerzo:** S. **Paralelo con:** R21-01, 09, 11, 12.

#### R21-01 Schema 11 y primitivas de store
- **Rama:** `feat/config-v11-store`.
- **FR:** base de E5-FR-10/23/29, E6-FR-14/22, E4-FR-07 (claves), E5-FR-19 (`agentsCollapsed`). Tambien D4 (base de E8-FR-30).
- **Archivos:**
  - `src/shared/types.ts` (`CONFIG_VERSION = 11`).
  - `src/main/store/schema.ts` con todas las claves v11 y defaults de zod: `settings.awakeMode`, `settings.terminalUnicode11`, `panes[].lastSession`, `settings.notifications.inAppWhenFocused`, `settings.agents.{resumeOnStartup, awakeDisplay, sidebarAgentRows, topicAsTitle, ctrlDigitFocus}`, `workspaces[].agentsCollapsed`, `settings.terminalAgentEndChip`. Sumar `.catch()` a `terminalRenderer`.
  - `src/renderer/lib/store.ts`: `DEFAULT_SETTINGS`, `mountedWorkspaces` + `ensureMounted(id, {only?})`.
  - `WorkspaceHost.tsx` lee `mounted` del store.
  - `PaneCell.tsx`: placeholder "Consola sin iniciar".
  - `persist.ts`: guarda solo ante cambios de referencia relevantes.
- **Schema:** 10 -> 11, sin logica en `migrate()`.
- **Tests:** en `test-status.cjs`, una config v10 parsea con defaults v11 y estampa 11, y `persist` no escribe ante cambios de `paneStatus`.
- **Verificacion manual:** P-DESK con una copia de la config real (exportada): carga sin perdida y `config.json` queda en v11.
- **Esfuerzo:** S. **Paralelo con:** R21-00, 09, 11, 12.

#### R21-02 Enriquecimiento de estado (owner unico)
- **Rama:** `feat/status-enrichment`.
- **FR:** E4-FR-09, E5-FR-01, E5-FR-02, E1-FR-01 (`addListener`/`onChange`), E1-FR-02 (cumplido por E4-FR-09), E1-FR-09 (fallback de preview desde `transcript_path`, adelantado de v2.2 porque es el mismo codigo que el fallback P1 de E5-FR-01), E6-FR-21 (parseo de `reason`/`cwd`). E5-FR-01 extiende el mismo listener de HookServer.
- **Archivos:**
  - `HookServer.ts`: `cwd`, `transcriptPath` validado, `prompt`, `lastAssistantMessage`, `endReason`, `toolSummary`, `question`.
  - `src/main/status/statusDetails.ts` (nuevo; une el `agentDetail.ts` de E5 con el `statusDetails.ts` de E4). Incluye la lectura de los ultimos 64 KB del transcript validado cuando Stop no trae `last_assistant_message`.
  - `events.ts`.
  - `StatusManager.ts`: `stateSince`, `lastMessage`, `activity`, `pending[]`, `sessionId`, `cwd`, `detail`, `topic`, `firstPrompt`, `cacheSince`, throttle de 500 ms, `addListener`, `stateOf`. Descarta `launch:` y los panes SSH.
  - `src/shared/types.ts` (`PaneStatus`/`PaneStatusEvt`), `src/renderer/lib/store.ts` (`setPaneStatus`, espejo de `lastSession`).
- **Schema:** sin cambio (usa 11).
- **Tests:** en `test-status.cjs`: `stateSince` estable dentro del mismo estado; recortes 280/200/120/2000; `questions` de AskUserQuestion; `isSafeTranscriptPath` (traversal, extension, basename); fallback de transcript cuando falta `last_assistant_message`; topic con `precise`; `firstPrompt` y su reinicio; listener con `state:null`; parseo HTTP real con 200 vacio.
- **Verificacion manual:** P-DESK con hooks en un `CLAUDE_CONFIG_DIR` temporal y Claude real (P-NOBILL). `status:state` trae `lastMessage` y `stateSince`, y no hay `console.*` con contenido.
- **Esfuerzo:** M. **Paralelo con:** R21-06, 07, 09, 11, 12.

#### R21-03 `agent-argv`, registro de sesiones y retomar
- **Rama:** `feat/agent-resume`.
- **FR:** E5-FR-05..11, 14. `restartPane.resume` del contrato (owner E4). D1 (parte resume), D2 y D5. E1-FR-33 (datos). Para E5-FR-11 este WP entrega el contrato ctl y el executor; la UI mobile aterriza en R21-14.
- **Archivos:**
  - `src/shared/agent-argv.ts` (nuevo: `buildAgentArgv`, `stripForResume`, `OVERRIDE_RE`, `SESSION_ID_RE`, `isSafeSessionId`, `buildCdPrefix`).
  - `src/shared/agents.ts` (nuevo: `decideLaunch`, `effectiveProvider`, `agentRank`, `formatAge`).
  - `src/main/agents/{AgentSessionStore, codexPaths, transcripts}.ts` (nuevos), `usage/codex.ts`.
  - `PtyManager.ts` (`getSpawnCwd`, `lastInputAt`), `src/main/ipc/registerAgentsIpc.ts` (nuevo).
  - `index.ts`: `snapshotExitOnce` en `before-quit`, `window-all-closed` y `session-end`.
  - IPC `agents:*`, `agentStore.ts`, `launch.ts`, `PaneCell.tsx` (menu, chip `ResumeChip`).
  - `store.ts` (`closePane`, `restorePane`, accion `reopenClosedPane`), `TilingGrid.tsx`.
  - `remote-protocol.ts`/`remote-protocol-schemas.ts`/`remoteCommands.ts` (`restartPane.resume`).
  - `remoteSnapshot.ts` (`RemotePaneInfo.resumable`, enmienda D10).
- **Schema:** usa 11 (`resumeOnStartup`, `lastSession`). Archivo nuevo `dataDir()/agent-sessions.json`.
- **Tests:** `scripts/test-agents.cjs` (nuevo, `npm run test:agents`, se suma a `npm test`): store (congelado post-snapshot, `endedAt` por `reason`, poda, crash, semilla desde `lastSession`), transcripts, tabla de verdad de `decideLaunch`, `buildAgentArgv`, `ctlActionSchema` con `resume`, `restorePane` (mismo id y posicion).
- **Verificacion manual (P-DESK + P-NOBILL):**
  - 2 panes de Claude, salir desde el tray y reabrir: retoman con el chip.
  - Kill desde el Administrador de tareas -> `crash`.
  - `shutdown /r /t 0` en VM -> `shutdown`.
  - Borrar el `.jsonl` -> fallback.
  - Un preset `claude "hola"` no reenvia el prompt.
  - Reabrir una consola cerrada desde el menu contextual o la paleta (el atajo se agrega y se verifica en R21-05).
  - Codex: verificar el orden de argumentos de `resume` (Riesgo E5-1) antes de cerrar el WP.
- **Esfuerzo:** L. **Paralelo con:** R21-04, 06, 07 (con orden de merge en `PtyManager.ts`).

#### R21-04 Pila de toasts, `revealPane` y aviso in-app
- **Rama:** `feat/toast-stack`.
- **FR:** E4-FR-03..08, E5-FR-04.
- **Archivos:** `src/renderer/lib/toast.ts`, `ui/NotificationStack.tsx`, `src/renderer/lib/revealPane.ts` (nuevos; `revealPane` llama primero a `setFocusedPane`). `App.tsx`, `common/Modal.tsx` (ignora `data-toast-root`), `RemoteQrModal.tsx`, `RemoteSection.tsx`, `GlobalPromptDialog.tsx`, `insertToConsole.ts`, `CommandPalette.tsx`, `remoteCommands.ts` (`deviceName`), `RemoteManager.ts`/`SessionManager.ts`, `StatusManager.ts` (`delivery`), `useStatusEvents.ts`, `NotificationsSection.tsx`.
- **Schema:** usa 11 (`inAppWhenFocused`).
- **Tests:**
  - `scripts/test-desktop-comfort.cjs` (nuevo, se suma a `npm test`) con `selectVisible`.
  - `test-status.cjs`: `delivery` inApp/native/none.
  - `test-status-ui.cjs`: pila a 860x560 con zoom 1/1.25/1.5, sobre `Modal` y debajo de `RemotePairingPrompt`.
- **Verificacion manual:** P-DESK. Copiar endpoint, prompt global con 3 consolas, snippet. Con Claude terminando en otro workspace y la ventana enfocada -> tarjeta con [Ir] y sin toast del SO. P-PHONE: prompt global desde el celu -> "Desde <dispositivo>".
- **Esfuerzo:** M. **Paralelo con:** R21-03, 06, 07, 09.

#### R21-05 Paleta "Te esperan", atajos, filas por agente y tooltips
- **Rama:** `feat/agent-navigation`.
- **FR:** E5-FR-15..20, E5-FR-29 (bloque Comportamiento), E4-FR-10, 11. Atajos segun D8.
- **Archivos:** `CommandPalette.tsx`, `keymap.ts` (`nextAttention` Ctrl+Shift+J, `reopenClosedPane` Ctrl+Shift+U, `focusNextPane`/`focusPrevPane` Ctrl+Alt+Right/Left), `useGlobalKeys.ts` (Ctrl+1..9 con exclusiones, `isEditableTarget`), `sidebarOrder.ts` (nuevo), `sidebar/AgentRows.tsx` (nuevo), `Sidebar.tsx` (selectores `useShallow`, tooltip combinado), `StatusDot.tsx` (`StatusGlyph`, `Tooltip` a 200 ms, `noTooltip`), `formatSince.ts` (nuevo), `KeymapSection.tsx`, `AgentsSection.tsx` (bloque Comportamiento), i18n.
- **Schema:** usa 11 (`sidebarAgentRows`, `topicAsTitle`, `ctrlDigitFocus`, `agentsCollapsed`).
- **Tests:** `test-agents.cjs` (`compareAgents`, `formatAge`). `test-status-ui.cjs`: filas por estado, "+N mas", "Sin iniciar", paleta con Ctrl+1 que enfoca el pane elegido, tooltip antes de 300 ms.
- **Verificacion manual:** P-DESK con 3 panes en `action` (estado inyectado o Claude real). Ctrl+Shift+J recorre. Ctrl+3 dentro de un textarea no actua. Ctrl+Shift+U reabre una consola cerrada (desde el desktop y una cerrada desde el celu). Con teclado es-latam, Ctrl+Alt+flechas no chocan con AltGr; si chocan, queda documentado el remapeo.
- **Esfuerzo:** M. **Paralelo con:** R21-06, 08.

#### R21-06 PC despierta
- **Rama:** `feat/awake`.
- **FR:** E5-FR-23, 24 y su parte de FR-29. Canales del contrato `power:setConfig`/`power:state` (unificados con los `agents:awake*` de E5: gana el contrato).
- **Archivos:** `src/main/agents/AwakeService.ts` (nuevo), `RemoteManager.ts` (cambios de dispositivos), `tray.ts`, `src/main/i18n.ts` (`tray.awake*`), `AwakeIndicator.tsx` (nuevo), `TitleBar.tsx`, `AgentsSection.tsx`.
- **Schema:** usa 11 (`awakeMode`, `awakeDisplay`).
- **Tests:** en `test-agents.cjs`, blocker y monitor falsos: modos, gracia de 120 s, stale de 2 h, `action` + celu, `resume`.
- **Verificacion manual:** build instalada local (o P-DESK). En Auto, con un pane `working`, `powercfg /requests` lista la peticion (EXECUTION o SYSTEM), que se libera a los 120 s; con `awakeDisplay` aparece en DISPLAY. En el equipo con Modern Standby, 30 min inactivo sin suspender.
- **Esfuerzo:** S. **Paralelo con:** R21-03, 04, 05, 07.

#### R21-07 Motor de terminal parte 1: modos, exit, Unicode11 y shell por defecto
- **Rama:** `feat/terminal-modes-unicode`.
- **FR:** E6-FR-33, 34, 32, 14, 15, 16. E6-FR-05 en su parte de v2.1.
- **Archivos:**
  - `src/main/pty/ModeTracker.ts`, `src/main/pty/shellResolve.ts`, `src/main/pty/ansiSanitize.ts` (`sanitizeQueries`) (nuevos).
  - `PtyManager.ts` (`historyTruncated`, `trimRingHead`, `PtyExitInfo`, rehidratacion de modos), `SessionManager.ts` (`exit` solo con `current && natural`), sinks de status/Codex.
  - `useXterm.ts` (`Unicode11Addon`), `TerminalSection.tsx`, `PaneCell.tsx` (`defaultShell`).
  - `remoteSnapshot.ts` + `remote-protocol.ts` (`terminalUnicode`), `RemoteTerminal.tsx`, mobile `store.ts`/`client.ts`.
  - `package.json`: `@xterm/xterm` 5.5.0 y `@xterm/addon-canvas` 0.7.0 exactos, mas `@xterm/addon-unicode11` 0.8.0.
- **Schema:** usa 11 (`terminalUnicode11`).
- **Tests:**
  - `scripts/test-terminal-engine.cjs` (nuevo, se suma a `npm test`): `ModeTracker` (listas, secuencia partida, RIS, alt screen), frame `exit` solo natural y vigente, `resolveShell`.
  - `scripts/test-mobile-terminal.cjs` (nuevo, xvfb): ancho del emoji = 2, replay con mouse capturado que llega a `touchScroll`.
- **Verificacion manual:**
  - P-DESK + P-PHONE: `printf` de emoji alineado. En el celu, abrir por primera vez un Claude con mucha salida -> el swipe llega al TUI.
  - `exit 3` en un pane suscrito -> un solo frame `exit`.
  - Checklist de mojibake (sleep/resume, desbloqueo, 6 panes con alt-tab) firmado en el PR.
- **Esfuerzo:** M. **Paralelo con:** R21-02, 03, 04, 06, 09.

#### R21-08 Tarjeta de salida, reinicio en el lugar y chip "Claude termino"
- **Rama:** `feat/exit-card-restart`.
- **FR:** E6-FR-17..20, 38, 21..23. D2.
- **Archivos:** `terminal/ExitCard.tsx`, `terminal/AgentEndChip.tsx`, `src/renderer/lib/restartRegistry.ts` (nuevos). `useXterm.ts` (`restartingRef`, `controller.restart`), `TerminalPane.tsx`, `store.ts` (`restartPane` en el lugar, `restartPaneClean`, `paneExit`, `agentEnded`), `PaneCell.tsx` ("Reiniciar limpio", "terminada"), `Sidebar.tsx`, `PtyManager.ts` (`restart`, `exited`), `RemoteManager.ts` (`exitCode`), IPC `pty:restart` y `status:sessionEnd`, mobile `RemoteTerminal.tsx` (franja de salida), `ConsoleDrawer.tsx` (sin spinner infinito).
- **Schema:** usa 11 (`terminalAgentEndChip`).
- **Tests:** `test-terminal-engine.cjs` (`PTY_RESTART` siembra contenido + tail sin modos y no emite `exit`; `exited` solo natural). `test-status.cjs` (allowlist de `reason`). `scripts/test-terminal-ui.cjs` (nuevo) con ExitCard y AgentEndChip en es/en, temas midnight/light.
- **Verificacion manual:** P-DESK. `exit` -> tarjeta, y Enter reinicia conservando el scrollback. `/exit` en Claude + `cd ..` -> [Retomar] abre la misma conversacion. Shell invalido -> error y fallback. P-PHONE: franja de salida y "terminada" en la lista.
- **Esfuerzo:** M. **Paralelo con:** R21-05, 10.

#### R21-09 Soltar archivos sobre un pane
- **Rama:** `feat/drop-attach`.
- **FR:** E7-FR-01..03.
- **Archivos:** `src/renderer/lib/{pasteRegistry, agentPane, dropPaths, dragNonce}.ts` (nuevos; `dropPaths.ts` con header MIT de Orca), `useXterm.ts` (registro del paster), `PaneCell.tsx` (drop, overlay con contador).
- **Schema:** sin cambio.
- **Tests:** `scripts/test-git.cjs` (nuevo; en v2.1 solo cubre `dropPaths`) con modos agent/safe/plain, raw/quoted y bytes de control.
- **Verificacion manual:** P-DESK. Captura PNG con y sin espacios sobre Claude real -> `[Image #1]` sin Enter. En PowerShell 5.1 y 7 se mantiene el comportamiento de 1.14.1. Bash por SSH con bracketed paste: separador espacio.
- **Esfuerzo:** S. **Paralelo con:** todos (requiere `THIRD_PARTY_NOTICES.md` de R21-00 antes del merge).

#### R21-10 M1: estado del agente en el celu
- **Rama:** `feat/mobile-agent-status`.
- **FR:** E1-FR-03..07, 40. Consume E1-FR-01/02/09 de R21-02. Overlay de status (owner E1).
- **Archivos:** `RemoteManager.ts` (`getPaneStatuses`, `toRemoteStatus` sin `sessionId`/`cwd`, dedupe y coalesce de 100 ms), `SessionManager.ts` (`broadcastPaneStatus`), `index.ts` (closures), `remote-protocol.ts` (`RemotePaneStatus`, `RemotePending`, `paneStatus`, `precise?` si se aprueba la enmienda). Mobile: `store.ts`, `client.ts` (`switchWorkspaceAndView`, comentario de `handlePaired`), `lib/workspace.ts`, `statusText.ts`, `inPageAlerts.ts` (nuevos), `StatusIndicator.tsx`, `WaitingPill.tsx` (nuevos), `ConsoleDrawer.tsx`, `MainScreen.tsx`, `ActionSheet.tsx`, i18n.
- **Schema:** sin cambio.
- **Tests:**
  - `scripts/test-remote.cjs` (nuevo, `test:remote`, en `npm test`): status por las dos rutas de `authOk`, dedupe/coalesce, solo sesiones autenticadas, un input de 8193 suma strike.
  - `scripts/test-mobile-logic.cjs` (nuevo): `statusText`, `inPageAlerts`, `switchWorkspaceAndView`.
- **Verificacion manual:** P-PHONE con Claude real en 2 workspaces. Indicadores, segunda linea, preview, pill "2 esperando" sin mover el desktop (log del server sin `switchWorkspace`), toast + vibracion en Android.
- **Esfuerzo:** M. **Paralelo con:** R21-08, 11, 12.

#### R21-11 M2: conexion confiable
- **Rama:** `feat/mobile-connection`.
- **FR:** E1-FR-10..15, 41.
- **Archivos:** `client.ts` (generacion, `abortSocket`, `CONNECT_TIMEOUT_MS`, liveness, `onRevive`, `reconnectNow`, `resyncPane`, `isOpen`, phase `updated`), `connectionHealth.ts`, `reconnectSchedule.ts` (nuevos), `store.ts`, `StatusBanner.tsx`, `MainScreen.tsx`, `StatusScreens.tsx` (`UpdatedScreen`), `App.tsx`, `vite.config.ts` (`__APP_VERSION__`), `env.d.ts`, i18n.
- **Schema:** sin cambio.
- **Tests:** en `test-mobile-logic.cjs`, la tabla de `endpointHint`, `delayFor`, la maquina de generacion con un WebSocket falso, el deadline cubierto por hidden y que `updated` ignore `state`.
- **Verificacion manual:** P-PHONE. Bloquear 5 min (socket vivo -> solo replay). Modo avion. Cortar Tailscale -> ambar en menos de 30 s. Cerrar el desktop -> "La PC se cerro". Dos builds locales con versiones distintas -> pantalla "Actualizado" estable mas de 70 s.
- **Esfuerzo:** S-M. **Paralelo con:** todos.

#### R21-12 M3: KeyBar parte 1
- **Rama:** `feat/mobile-keybar`.
- **FR:** E1-FR-16..21.
- **Archivos:** `KeyBar.tsx`, `lib/keys.ts`, `lib/keyPress.ts` (nuevos), `viewport.ts` (`keyboardInset`), `store.ts` (`kbOpen`), i18n (`key.ctrlEnter` -> "Nueva linea").
- **Schema:** sin cambio.
- **Tests:** en `test-mobile-logic.cjs`, `createKeyPress` con timers falsos (tap = 1, hold de 1 s = 14, slop, cancel, 15 s, send false).
- **Verificacion manual:** P-PHONE. Bksp/Del en PowerShell, cmd, WSL y Claude. Deslizar sobre ^D no manda nada. "Nueva linea" inserta un salto en Claude.
- **Esfuerzo:** S. **Paralelo con:** todos.

#### R21-13 M4: composer acoplado
- **Rama:** `feat/mobile-composer`.
- **FR:** E1-FR-22..31, 38.
- **Archivos:** `Composer.tsx`, `DirectInputStrip.tsx`, `lib/composerSend.ts`, `drafts.ts`, `prefs.ts`, `mobileStorage.ts` (nuevos), `MainScreen.tsx`, `RemoteTerminal.tsx` (readOnly + `inputmode`), `SnippetsSheet.tsx`, `client.ts` (troceo, `clearMobileStorage`), `store.ts`. Se elimina `PasteSheet.tsx` (ver D11).
- **Schema:** sin cambio.
- **Tests:** `test-mobile-logic.cjs` (`chunkInput` con pares surrogate, `typeSlash`, `isAgentPane`, poda de drafts). `scripts/test-mobile-ui.cjs` (nuevo, xvfb): foco del composer con la KeyBar y textarea helper en readOnly.
- **Verificacion manual:** P-PHONE. Dictado, corrector, `/model` tipeado, long-press Insert, Stop con Claude en `working`, draft al cambiar de pane, texto de 10000 caracteres. Sin conexion, Send queda deshabilitado.
- **Esfuerzo:** M. **Paralelo con:** R21-14.

#### R21-14 M5: tabs, Sheet nuevo, ActionList, Back y Ajustes como pantalla
- **Rama:** `feat/mobile-nav-sheets`.
- **FR:** E1-FR-32..37, 39 ("Relanzar retomando" y "Chat nuevo" usan `resumable`). E5-FR-11 (UI mobile: filas con confirmacion sobre el contrato de R21-03).
- **Archivos:** `PaneTabs.tsx`, `lib/longPress.ts`, `paneIcon.tsx`, `PaneActionSheet.tsx`, `ActionList.tsx`, `backStack.ts`, `useBackClaim.ts`, `PushScreen.tsx`, `SettingsScreen.tsx` (nuevos), `Sheet.tsx` (drag y salida), `ActionSheet.tsx`, `ConsoleDrawer.tsx`, `index.css`, i18n mobile (`act.restartResume`, `act.restartFresh`).
- **Schema:** sin cambio.
- **Tests:** `test-mobile-logic.cjs` (`backStack`: doble pop, dos claims, `orphanAll`). `test-mobile-ui.cjs` (long-press de 450 ms, drag de 100/40 px, `transitionend`, reduced-motion, sin overflow, filas de retomar visibles u ocultas segun `resumable`).
- **Verificacion manual:** P-PHONE. Atras de Android con sheets apilados. Edge-swipe de Safari. PWA de iOS sin boton atras. Relanzar retomando desde el celu sobre un pane con `lastSession`.
- **Esfuerzo:** M. **Paralelo con:** R21-13.

#### R21-15 Release v2.1.0
- **Rama:** `release/v2.1.0`.
- **Contenido:** bump, `docs/release-notes/v2.1.0.md` con el checklist de mojibake firmado, CI completo y "Proceso de release". Despues, update 2.0.0 -> 2.1.0 en la instalada y la portable en VM.
- **Esfuerzo:** S.

#### R21-16 Contingencia: bloque "Datos de SnMultiCC" (retirado)
- **Estado:** retirado, no se agenda. E0-FR-11 (bloque manual de importar y eliminar) quedo reemplazado por la migracion y limpieza automaticas de E0-FR-27..36, que salen completas en v2.0.0 (R20-04 y R20-05) y no tienen contingencia hacia v2.1. El id se conserva para no romper referencias.
- Si en v2.1 hace falta algo del legado (por ejemplo, un item que quedo `deferred` en muchos usuarios), entra como fix en un WP de v2.1.x sobre `legacyInventory.ts`, no como un bloque manual en Ajustes.

**PRs de v2.1.0:** un PR por WP (R21-00..14), con R21-11 y R21-12 publicables en cualquier orden. Si el calendario aprieta, se corta un v2.1.1 con R21-13/R21-14, siempre despues de R21-10.

---

### v2.2.0: Home y respuestas con un tap + comodidad desktop

Regla de merge: R22-01 mergea primero. R22-04, 06, 07, 08, 09, 10, 12 y 13 consumen claves v12 y mergean despues aunque se desarrollen en paralelo. Archivos calientes: `PtyManager.ts` (R22-02, 07, 08, 12, 15), `updater.ts`/`registerUpdateIpc.ts` (R22-02 -> R22-04 -> R22-08) y los archivos mobile de `MainScreen`/`QuickCommandsSheet` (R22-12 -> R22-14 -> R22-18).

#### R22-01 Schema 12 y modelo QuickCommand
- **Rama:** `feat/config-v12`.
- **FR:** E8-FR-01 y las claves v12 del contrato.
- **Claves:** `settings.updateDismissedVersion`, `explorerMenu`, `persistScrollback`, `persistScrollbackLines`, `gitChip`, `quickCommands` (top-level), `notifications.ntfy`, `notifications.onlyWhenAway`. Mas las enmiendas: `terminalSnapshotMode`, `settings.agents.{resumeModalTimeoutSec, resumeNudge, resumeNudgeText, sidebarSort}`, `settings.automation.{defaultAgentPresetId, composerCreateAnother}`, `workspaces[].note`/`taskState`.
- **Archivos:** `src/shared/types.ts`, `src/shared/quickCommands.ts` (nuevo, header MIT si copia tipos), `schema.ts` (`migrate()` con snippets -> quickCommands, parseo item por item), `store.ts` (`quickCommands`, `mergeConfig` con `remapScopes`), `persist.ts`.
- **Schema:** 11 -> 12 (unica migracion real).
- **Tests:** `scripts/test-automation.cjs` (nuevo, en `npm test`): migracion idempotente, item corrupto, 120 -> 100, remap. `test-status.cjs`: defaults de ntfy y export sin topic/token.
- **Verificacion manual:** P-DESK con la config real exportada (con snippets): carga, el siguiente guardado no tiene `snippets` y el export no lleva secretos de ntfy.
- **Esfuerzo:** M. **Paralelo con:** desarrollo en paralelo con todo; mergea primero.

#### R22-02 Ciclo de vida explicito del pty y estado del update en main
- **Rama:** `fix/pty-lifecycle`.
- **FR:** E4-FR-36, 37. D3.
- **Archivos:** `useXterm.ts` (el cleanup no mata), `src/renderer/lib/ptyLifecycle.ts` (nuevo), `ptyRegistry.ts`, `store.ts` (`restartPane` sigue el camino en el lugar de R21-08; `restartPaneClean` mata antes del epoch), `PtyManager.ts` (`killPanes`, `reconcile`), `registerPtyIpc.ts`, `updater.ts` (`UpdateState`), `registerUpdateIpc.ts` (guard `inflight`, `update:getState`/`update:state`), `renderer/lib/updater.ts`, `TitleBar.tsx`.
- **Schema:** sin cambio.
- **Tests:** en `test-desktop-comfort.cjs`, `ptyLifecycle` (remove, import, restart), `killPanes`/`reconcile` y el guard de `UPDATE_INSTALL`.
- **Verificacion manual:** P-DESK. Reiniciar desde el header, el menu y el celu -> `count` constante. Recargar el renderer y borrar un workspace no visitado -> `count` baja. `importConfig` mata solo los ausentes.
- **Esfuerzo:** M. **Paralelo con:** R22-01, 05, 10.

#### R22-03 Resiliencia ante crashes
- **Rama:** `feat/crash-resilience`.
- **FR:** E4-FR-19..25.
- **Archivos:**
  - `common/ErrorBoundary.tsx` (nuevo).
  - `PaneCell.tsx`, `TilingGrid.tsx`, `App.tsx`, `main.tsx` (`onUncaughtError`).
  - `renderErrors.ts`, `devHooks.ts` (nuevos).
  - `src/main/crash/{RecoveryBreaker, crashStore}.ts` (header MIT en `RecoveryBreaker`).
  - `src/main/diagnostics/{logRing, buildDiagnostics}.ts`, `src/shared/redact.ts` (compartido con R22-17).
  - `index.ts` (`render-process-gone`, `unresponsive`), `window.ts` (Ctrl+Shift+Alt+K, F12 sin modificadores), IPC `app:*`, `AboutSection.tsx`.
- **Schema:** sin cambio. Carpeta nueva `dataDir()/crashes`.
- **Tests:** `test-desktop-comfort.cjs` (breaker, `shouldAutoReload`, throttle, `redact`, allowlist de diagnostico con `send: 'hunter2'`). `test-status-ui.cjs` (los boundaries no llaman a `killPanes`).
- **Verificacion manual:** P-DESK dev. `__snaosDev.throwPane` con `ping -t` corriendo: el contador sigue. Ctrl+Shift+Alt+K 3 veces -> dialogo. [Cerrar SnAgentsOS] en la build instalada local.
- **Esfuerzo:** M. **Paralelo con:** R22-04, 07.

#### R22-04 Tarjeta de update y chip en el titlebar
- **Rama:** `feat/update-card`.
- **FR:** E4-FR-12..18.
- **Archivos:** `updater.ts` (`/releases?per_page=30`, `selectReleases`, tope de 5 MB, `SNAOS_UPDATE_REPO` solo en dev), `UpdateCard.tsx`, `update-card-visibility.ts` (header MIT) (nuevos), `UpdateModal.tsx` -> `ReleaseNotesModal.tsx`, `TitleBar.tsx`, `App.tsx`, `UpdatesSection.tsx`.
- **Schema:** usa 12 (`updateDismissedVersion`). `update:check` agrega `newerCount`.
- **Tests:** `test-desktop-comfort.cjs` (`selectReleases`: draft/prerelease, not ready por falta de `.sha256`, topes de 30 releases y 64 KB; tabla de visibilidad). `test-status-ui.cjs` (tarjeta con +3, chip al 42%).
- **Verificacion manual:** portable e instalador con `version` bajada localmente contra el repo real. Aviso de consolas, doble confirmacion, chip, corte de red, recarga al 40% (el chip vuelve).
- **Esfuerzo:** M. **Paralelo con:** R22-03, 05 (mergea despues de R22-01 y R22-02).

#### R22-05 Busqueda en ajustes, deep links, KeyHint y foco del wizard
- **Rama:** `feat/settings-search-keyhints`.
- **FR:** E4-FR-26..31.
- **Archivos:** `settings/searchCatalog.ts` (nuevo), `SettingsModal.tsx`, `settings/ui.tsx`, secciones (`searchId`), `store.ts` (`openSettings('cat#fila')`), `RemoteIndicator.tsx`, `ui/KeyHint.tsx` (nuevo), `keymap.ts` (`accelParts`), `Button.tsx`, `WizardFooter.tsx`, `NewWorkspaceWizard.tsx`, `GlobalPromptDialog.tsx`, `ConfirmDialog.tsx`, `Sidebar.tsx`.
- **Schema:** sin cambio.
- **Tests:** `test-desktop-comfort.cjs` (`matchesSettingsSearch`, integridad del catalogo). `test-status-ui.cjs` (busqueda sin `updates.check` ni `getMetrics`, foco del wizard).
- **Verificacion manual:** P-DESK. "sonido", "paleta", deep link `notifications#sound`. Ctrl+Shift+N + Enter no escribe en el pty.
- **Esfuerzo:** M. **Paralelo con:** R22-01..04.

#### R22-06 "Abrir en SnAgentsOS" desde el Explorador
- **Rama:** `feat/explorer-open`.
- **FR:** E4-FR-32..35.
- **Archivos:** `src/main/openRequest.ts`, `src/main/shellIntegration.ts` (nuevos), `index.ts` (`second-instance` con `workingDirectory`), `paths.ts` (`portableExeFile`), IPC `app:openPath` (`OpenRequest`), `app:takePendingOpen`, `system:setExplorerMenu` (forma objeto, enmienda), `system:getExplorerMenu`, `renderer/lib/openRequest.ts`, `StartupSection.tsx`, `build/installer.nsh` (agrega `customUnInstall`, D7). Si R22-13 ya entro, abre el composer con el cwd; si no, abre el wizard.
- **Schema:** usa 12 (`explorerMenu`).
- **Tests:** `test-desktop-comfort.cjs` (`parseOpenArg` con `C:"`, UNC, timeout y switches intercalados; `buildExplorerRegOps`; matching).
- **Verificacion manual:** build instalada en VM. Menu clasico con la app cerrada y abierta, raiz `C:\`, portable movido, desinstalar (borra) y actualizar (conserva).
- **Esfuerzo:** S-M. **Paralelo con:** R22-07, 10.

#### R22-07 Snapshot headless
- **Rama:** `feat/headless-snapshot`.
- **FR:** E6-FR-01..07, 35.
- **Archivos:** `src/main/pty/HeadlessMirror.ts` (header MIT), `xtermEnv.ts` (si hace falta), `PtyManager.ts` (mirror, gen, `snapCache`, `setEngine`), `registerPtyIpc.ts` (`pty:setEngine`), `index.ts`, `store.ts`/`App.tsx`, `useXterm.ts` (reattach con `cols`/`rows`), `ipc-contract.ts`, `TerminalSection.tsx` (Avanzado). `package.json`: `@xterm/headless` 5.5.0 y `@xterm/addon-serialize` 0.13.0 exactos.
- **Schema:** usa 12 (`terminalSnapshotMode`).
- **Tests:** `test-terminal-engine.cjs` (ida y vuelta, cola parcial, DA1/DSR sin write, modos por mirror, cache). `scripts/bench-headless.cjs` (`npm run bench:terminal`, fuera del gate).
- **Verificacion manual:** P-DESK. `win.reload()` con Claude trabajando: pantalla correcta sin tocar teclas. `AppMetrics.headless` con 8 panes. Bench con el resultado anotado en el PR. Si no cumple el presupuesto, el default pasa a `lazy` (Riesgo E6-1).
- **Esfuerzo:** M-L. **Paralelo con:** R22-03, 06, 10.

#### R22-08 Scrollback persistido
- **Rama:** `feat/scrollback-persist`.
- **FR:** E6-FR-08..13, 36, 37.
- **Archivos:** `src/main/pty/ScrollbackStore.ts` (nuevo), `ansiSanitize.ts` (`sanitizeSeed`), `PtyManager.ts`, `ConfigStore.ts` (`lastLoadSource`), `index.ts` (checkpoint de 60 s, `persistOnExit` en los 4 caminos), `updater.ts` (`beforeApply` solo `win-installer`), `registerUpdateIpc.ts`, IPC `scrollback:*`, `src/main/i18n.ts` (separador), `useXterm.ts` (seed antes de `bind`, usando `decideLaunch`), `store.ts`, `PaneCell.tsx`, `TerminalSection.tsx`.
- **Schema:** usa 12 (`persistScrollback*`). Carpeta `dataDir()/scrollback`.
- **Tests:** en `test-terminal-engine.cjs`, store atomico (EPERM simulado), GC salteado con backup, seed consumido una vez, seed de 600 KB, sanitizado y `persistAllSync` con 12 panes.
- **Verificacion manual:** VM con build instalada. Cerrar con la X, desde el tray, update de la portable y del instalador (cancelar el wizard y salir) y apagar -> historial y separador. Un pane que retoma no restaura.
- **Esfuerzo:** M. **Paralelo con:** R22-09, 11 (mergea despues de R22-04 por `updater.ts`).

#### R22-09 Agentes v2.2: modal de retomar, nudge, detalle Codex, topic y orden Smart
- **Rama:** `feat/resume-modal`.
- **FR:** E5-FR-12, 13, 3, 21, 22. E1-FR-08 (el `agentMessage` completado de Codex se publica como `lastMessage`, D12).
- **Archivos:** `agents/ResumeDialog.tsx` (nuevo, header MIT si adapta la agrupacion), `App.tsx`, `CodexProtocol.ts`/`CodexBridge.ts` (detalle y `lastMessage` desde el App Server), `StatusManager.ts` (`lastMessage` de Codex, recorte a 280), `PaneCell.tsx` (topic en el header), `sidebarOrder.ts` (Smart y congelado), `Sidebar.tsx`, `useGlobalKeys.ts` (Alt+N sigue el orden Smart).
- **Schema:** usa 12 (`resumeModalTimeoutSec`, `resumeNudge*`, `sidebarSort`).
- **Tests:** `test-agents.cjs` (cuenta regresiva, nudge con timers falsos, Smart). `test-status.cjs` (contrato de Codex simulado: commandExecution como detail, agentMessage como `lastMessage`). `test-status-ui.cjs` (modal a 100/125/150%).
- **Verificacion manual:** P-DESK. 2 interrumpidos en 2 workspaces. Cuenta de 60 s sin interaccion. "No preguntar mas". Codex `commandExecution` en la fila. P-PHONE: un `lastMessage` de Codex aparece en el celu igual que uno de Claude.
- **Esfuerzo:** M. **Paralelo con:** R22-08, 10.

#### R22-10 GitService, chip y git en el snapshot
- **Rama:** `feat/git-chip`.
- **FR:** E7-FR-05..10. Canales segun D6.
- **Archivos:**
  - `src/shared/git-types.ts`, `src/main/git/{gitExec, porcelain, untrackedLines, GitService}.ts`, `src/main/ipc/registerGitIpc.ts` (nuevos).
  - `index.ts`, IPC `git:setWatch`/`git:update`/`git:info`/`git:setConfig`/`git:refresh`.
  - `gitStore.ts`, `gitSync.ts`, `git/GitChip.tsx`, `GitSection.tsx` (nuevos).
  - `WorkspaceView.tsx`, `Sidebar.tsx`, `remoteSnapshot.ts` (`RemoteWorkspaceInfo.git`), `themes/tokens.ts` (ansi-green/red).
- **Schema:** usa 12 (`gitChip`).
- **Tests:** en `test-git.cjs`, parsers `-z`, repos reales en temp (staged+modificado, unborn, remoto bare, untracked con presupuesto, `GIT_DIR` contaminado), `GitService` con timers falsos (single-flight, sin auto-refresco) y ausencia de repoRoot en el snapshot.
- **Verificacion manual:** P-DESK sobre 3 repos reales (uno con rebase). CPU con 10 workspaces durante 10 min. Sin `index.lock` mientras Claude hace commit.
- **Esfuerzo:** M. **Paralelo con:** desarrollo en paralelo con R22-02..09; mergea despues de R22-01.

#### R22-11 Panel Changes
- **Rama:** `feat/changes-panel`.
- **FR:** E7-FR-11..16, 04.
- **Archivos:** `changes/{ChangesPanel, FileList, DiffView}.tsx`, `src/main/git/diff.ts` (nuevos), IPC `git:status`/`git:fileDiff`/`git:openFile`, `keymap.ts` (`toggleChanges` Ctrl+Shift+D), `useGlobalKeys.ts`, `CommandPalette.tsx`, `PaneCell.tsx` (drop MIME interno validado), i18n.
- **Schema:** sin cambio.
- **Tests:** `test-git.cjs` (hunks, validacion de paths, allowlist de `openFile`). `scripts/test-git-ui.cjs` (nuevo, xvfb): F7, sin overflow, colores del tema.
- **Verificacion manual:** P-DESK con un cambio real de Claude. F7/Shift+F7 no escriben en la consola. Abrir un `.bat` muestra la carpeta. Arrastrar una fila a otro pane. Un MIME custom desde Chrome no hace nada.
- **Esfuerzo:** M. **Paralelo con:** R22-08, 12.

#### R22-12 Quick Commands y entrega de prompts compartida
- **Rama:** `feat/quick-commands`.
- **FR:** E8-FR-02..07. D1 (prompt inicial unificado con E2-FR-11: este WP crea `initialPrompt.ts` y `shellKind.ts`, que consume R22-14). ctl `runQuickCommand` y `snapshot.quickCommands`.
- **Archivos:**
  - `src/shared/initialPrompt.ts`, `shellKind.ts` (nuevos), `agent-argv.ts` (prompt).
  - `PtyManager.ts` (`submit` despues del vaciado, rastreo de DECSET 2004, gate con `agentState`), `StatusManager.ts` (`stateOf`).
  - IPC `pty:submit`/`pty:promptResult`, `usePaneScheduler.ts` (usa `submit`), `useXterm.ts` (`pendingPrompts`), `launch.ts` (`launchKind`).
  - `quickCommands.ts` (renderer), `QuickCommandPopover.tsx`, `QuickCommandsSection.tsx` (nuevos), `keymap.ts` (Ctrl+Shift+Q), `CommandPalette.tsx`, `SettingsModal.tsx`.
  - `remote-protocol*.ts`, `remoteSnapshot.ts`, `remoteCommands.ts`, mobile `QuickCommandsSheet.tsx` (reemplaza a `SnippetsSheet`), `KeyBar.tsx`.
- **Schema:** usa 12.
- **Tests:** en `test-automation.cjs`, `submit` (64 KB + `\r` tardio, 2004 partido, `multiline_unsafe`), tabla argv/gate/fallback, `initialPromptFallback` (`%`, mas de 2000, SSH, shell desconocido), `stateOf`, `runQuickCommand` estricto. Mobile: `test-mobile-quick` o una extension de `test-mobile-ui`.
- **Verificacion manual:** P-DESK + P-PHONE. Ctrl+Shift+Q y despues 2. Agent QC en una carpeta nueva de Claude (el dialogo de confianza no se acepta solo). QC multilinea a cmd.exe -> toast. Desde el celu, `send` a la consola abierta aunque el desktop enfoque otra.
- **Esfuerzo:** M. **Paralelo con:** R22-10, 11 (mergea antes de R22-14).

#### R22-13 Composer de workspace y nota/estado
- **Rama:** `feat/workspace-composer`.
- **FR:** E8-FR-08..10.
- **Archivos:** `wizard/WorkspaceComposer.tsx`, `sidebar/WorkspaceNotePopover.tsx` (nuevos), `NewWorkspaceWizard.tsx` (`initialDraft`), `store.ts` (`composerOpen`, `firstPrompt`, `setWorkspaceNote`/`TaskState`), `Sidebar.tsx`, `registerSystemIpc.ts` (`fs:dirExists`).
- **Schema:** usa 12 (`note`, `taskState`, `automation.*`).
- **Tests:** `test-automation.cjs` (schema de nota). `scripts/test-automation-ui.cjs` (nuevo): composer y sidebar con notas largas.
- **Verificacion manual:** P-DESK. Ctrl+Shift+N + carpeta + Ctrl+Enter. "Crear otro". El primer prompt va solo a la primera consola de agente.
- **Esfuerzo:** S-M. **Paralelo con:** R22-14..19.

#### R22-14 M6: Home real
- **Rama:** `feat/mobile-home`.
- **FR:** E2-FR-01..16, 47, 49..51, 12.
- **Archivos:**
  - Mobile: `LiveShell.tsx`, `HomeScreen.tsx`, `home/*` (`WorkspaceSection`, `ConsoleRow`, `ResumeCard`, `Fab`, `NewConsoleSheet`, `EmptyStates`, `UsageCards`, `GitChip`), `PaneActionList.tsx`, `QuickCommandsSheet` (reuso del de R22-12), `store.ts` (`screen`, `toasts`, `viewedWorkspaceId`), `prefs.ts`, `client.ts` (`openPane`, `pendingDeepLink`, sin `pickPane`). Se borran `ActionSheet.tsx` y `ConsoleDrawer.tsx`.
  - Desktop: `remoteSnapshot.ts` (`presets`, `mountedWorkspaceIds`), `RemoteManager.ts` (`hostName` en `overlayRunning`), `SessionManager.ts` (`promptFallback`), `remoteCommands.ts` (`mountWorkspace`, `revealPane`, `openUrl`, `createPane.prompt`), `main/window/revealWindow.ts` (nuevo), `initialArgs.ts`.
- **Schema:** sin cambio.
- **Dependencias:** R22-12 (`initialPrompt.ts`, `shellKind.ts`, `QuickCommandsSheet`, `runQuickCommand`). R22-10 es opcional: sin `RemoteWorkspaceInfo.git`, E2-FR-50 no reserva espacio.
- **Tests:** `test-mobile-ui.cjs` (orden de filas, colapso, workspace visto, FAB con `promptFallback`, PaneActionList con `resumable`). `test-remote.cjs` (`hostName` en push, `promptFallback`).
- **Verificacion manual:** P-PHONE. Abrir una consola de un workspace no montado -> confirmacion, y el desktop no cambia. FAB Claude con el prompt `explica "x" y $HOME` en PowerShell. "Mostrar en la PC" con la ventana minimizada.
- **Esfuerzo:** L. **Paralelo con:** R22-16, 17, 19.

#### R22-15 M7: tarjetas de permiso y pregunta
- **Rama:** `feat/mobile-prompt-cards`.
- **FR:** E2-FR-17..25, 48.
- **Archivos:** `src/shared/askAnswerKeys.ts` (header MIT), `StatusManager.ts` (`onUserInput`, `requestAt`, `invalidated`), `PtyManager.ts` (notifica `onUserInput`), mobile `promptRules.ts` (header MIT), `answer.ts`, `prompts/*`.
- **Schema:** sin cambio.
- **Tests:** `test-status.cjs` (invalidacion: focus/mouse no invalidan, una letra si, sin tocar `state`; `buildAskAnswerKeys` con 8 opciones + Otro). `test-mobile-ui.cjs` (lock, aborto, "Ya se respondio", mas de 24 grupos).
- **Verificacion manual:** P-PHONE + P-NOBILL en un directorio temporal. `ls` Permitir/Denegar. `sleep 30` aprobado (la tarjeta desaparece y un segundo tap no escribe). AskUserQuestion de 1 y 2 preguntas con Otro. ExitPlanMode muestra solo la tira. Responder en el desktop.
- **Esfuerzo:** M. **Paralelo con:** R22-16..19 (mergea despues de R22-12 por `PtyManager.ts`).

#### R22-16 M8: texto usable
- **Rama:** `feat/mobile-text`.
- **FR:** E2-FR-26..34.
- **Archivos:** mobile `selection.ts`, `links.ts` (header MIT), `clipboard.ts`, `SelectionOverlay.tsx`, `LinkSheet.tsx`, `NewLinesPill.tsx`, `ScrollThumb.tsx` (nuevos), `touchScroll.ts`, `fit.ts`, `RemoteTerminal.tsx`. Desktop: `src/main/remote/pathOpen.ts` (nuevo), IPC `shell:openPath`, `remoteCommands.ts` (`openPath` con raices del store).
- **Schema:** sin cambio.
- **Tests:** `test-status.cjs` (`pathOpen`: junction que escapa, `.js` revela, raiz home). `test-mobile-scroll.cjs` (momentum, tope de wheel, long-press, `execCommand` dentro del evento) sin perder los checks actuales.
- **Verificacion manual:** P-PHONE. Copiar en iOS y Android y pegar en otra app. `localhost:5173` "Abrir en la PC". `src/App.tsx:12` lo muestra en el Explorador. `..\..\Windows\System32\calc.exe` da `denied_path`.
- **Esfuerzo:** M-L. **Paralelo con:** R22-15, 17, 18.

#### R22-17 M9: diagnostico y firewall
- **Rama:** `feat/mobile-diagnostics`.
- **FR:** E2-FR-35..39.
- **Archivos:** mobile `connLog.ts`, `diagnostics.ts`, `DiagnosticsScreen.tsx`, `PairLog.tsx`, `StatusScreens.tsx`, `client.ts`. Desktop: `src/main/remote/firewall.ts` (header MIT), `registerRemoteIpc.ts` (`remote:firewallCheck`/`firewallFix`/`openNetworkSettings`), `FirewallStatusRow.tsx`, `RemoteQrModal.tsx`, `RemoteSection.tsx`. Reusa `src/shared/redact.ts` de R22-03 (o lo crea si llega primero). La entrada desde Ajustes y desde el punto del header se cablea sobre `SettingsScreen`/header de R22-14; si R22-14 no entro, solo desde el banner.
- **Schema:** sin cambio.
- **Tests:** `test-status.cjs` (parser de firewall con JSON enlatado, builder del script elevado sin ejecutar PowerShell, `connLog.redact`).
- **Verificacion manual:**
  - VM: red Publica, Block creada cancelando Defender sobre el exe instalado, Allow sobre el exe anterior al rebrand (no cuenta), UAC aceptado y cancelado, portable.
  - P-PHONE: IP equivocada -> techo de 25 s.
- **Esfuerzo:** M. **Paralelo con:** R22-15, 16, 18.

#### R22-18 ntfy, "solo cuando no estoy en la PC", deep links y toasts del celu
- **Rama:** `feat/ntfy-away`.
- **FR:** E2-FR-40..44, 52.
- **Archivos:** `src/main/status/{desktopAway (header MIT), NtfyNotifier, noticeRouter}.ts` (nuevos), `index.ts` (router perezoso, export sin ntfy), `registerStatusIpc.ts` (`status:ntfyTest`), `RemoteServer.ts`/`SessionManager.ts`/`DeviceRegistry.ts` (`lastHost`), `RemoteManager.ts` (`deepLinkBase`, `isPaneViewed`), `NotificationsSection.tsx`, mobile `deepLink.ts`, `notify.ts`, `ToastStack.tsx`, `client.ts` (`visibility`).
- **Schema:** usa 12 (`ntfy`, `onlyWhenAway`).
- **Tests:** `test-status.cjs` (NtfyNotifier con fetcher falso, noticeRouter con idle/locked/unknown/error, `setLastHost`). `test-mobile-ui.cjs` (deep link pendiente, `pair=` gana).
- **Verificacion manual:** P-PHONE con un topic de prueba del usuario. PC activa -> sin push. Win+L -> push. Celu visible en la consola -> sin push. Tap en el push -> la consola correcta. PWA de iOS documentada.
- **Esfuerzo:** M. **Paralelo con:** R22-15..17.

#### R22-19 KeyBar parte 2
- **Rama:** `feat/mobile-keybar-layout`.
- **FR:** E2-FR-45, 46.
- **Archivos:** `lib/keys.ts` (`normalizeLayout`, `insertMissingBuiltInIds`, constructor de bytes, header MIT), `KeyLayoutScreen.tsx`, `CustomKeySheet.tsx` (nuevos), `KeyBar.tsx`. La entrada "Barra de teclas" vive en `SettingsScreen` (R22-14).
- **Schema:** sin cambio.
- **Tests:** `test-mobile-ui.cjs` (reordenar/ocultar/insertar). `test-mobile-logic.cjs` (tabla de bytes: Ctrl+Flecha derecha = `\x1b[1;5C`).
- **Verificacion manual:** P-PHONE con `cat -v`.
- **Esfuerzo:** S-M. **Paralelo con:** todos los mobile.

#### R22-20 Espejo mobile del chip "Claude termino"
- **Rama:** `feat/mobile-agent-end-chip`.
- **FR:** E6-FR-24.
- **Archivos:** `src/shared/remote-protocol.ts` (`RemoteCtlAction` `agentResume { workspaceId, paneId, mode: 'resume' | 'new' }`), `src/shared/remote-protocol-schemas.ts` (zod `mode: z.enum(['resume','new'])`), `src/renderer/lib/remoteCommands.ts` (executor: valida pertenencia como `restartPane`, borra `agentEnded[paneId]` en la primera accion y responde `ctlAck { ok:false, error:'stale' }` a las siguientes), `remoteSnapshot.ts` o `paneStatus` (marca de sesion terminada para el celu, segun la enmienda de R22-01), mobile `RemoteTerminal.tsx`/pantalla Terminal de R22-14 (franja Retomar/Nueva), i18n mobile.
- **Schema:** sin cambio (enmienda ctl `agentResume` cerrada en R22-01).
- **Tests:** `test-remote.cjs` (zod del ctl, `paneId` de otro workspace rechazado, segunda accion `stale`). `test-mobile-ui.cjs` (franja visible solo con la sesion terminada).
- **Verificacion manual:** P-PHONE + P-NOBILL. `/exit` en Claude: la franja aparece en el celu, Retomar y Nueva producen el mismo texto en el pty que en el desktop, y dos dispositivos que tocan a la vez generan un solo comando.
- **Esfuerzo:** S. **Paralelo con:** R22-15..19 (despues de R22-14).

#### R22-21 Release v2.2.0
- **Rama:** `release/v2.2.0`.
- **Contenido:** bump, notas (incluye el aviso de migracion de Snippets y el resultado del bench) y update 2.1 -> 2.2 con la tarjeta nueva. Desde esta release, el propio updater muestra la tarjeta en lugar del modal.
- **Esfuerzo:** S.

**PRs de v2.2.0:** un PR por WP. R22-16 y R22-19 se pueden juntar si quedan chicos. Corte de contingencia: si R22-07/08 no cumplen el bench, salen en v2.2.1 con default `lazy`; eso no bloquea v2.2.0.

---

### v3.0.0: El celu como herramienta de trabajo + automatizacion y git pesado

Regla de merge: R30-01 mergea primero. R30-02 mergea antes que todo WP que agregue mensajes o ctl remotos (R30-03..07, R30-09a). R30-04 mergea antes que R30-05 (E3-FR-21/22/25).

#### R30-01 Schema 13 y enmiendas v3.0
- **Rama:** `feat/config-v13`.
- **FR:** claves v13 del contrato:
  - `settings.remote.phoneFit`, `settings.remote.https`, `settings.cliEnabled`, `settings.worktreesRoot`, `panes[].worktree`, `settings.hibernateIdleMinutes`.
  - `repoConfigTrust` y `automations`: segun la enmienda (ver Riesgos), el trust vive en `dataDir()/trusted-repos.json` y las automatizaciones extienden `PaneSchedule` por pane.
  - Enmiendas: `settings.agents.cacheTimer`, `settings.automation.{cliProtectSsh, cliUserPath, scheduleGraceMin, scheduleMaxWaitMin, scheduleNotify}`, `workspaces[].repoConfig`.
- **Archivos:** `types.ts`, `schema.ts` (`paneWorktreeSchema`, `paneScheduleSchema` extendido), `store.ts`.
- **Schema:** 12 -> 13 (sin logica).
- **Tests:** `test-automation.cjs` y `test-git.cjs` (v12 -> v13 conserva todo, el worktree no se pierde al recargar).
- **Verificacion manual:** P-DESK con una config v12 real.
- **Esfuerzo:** S. **Paralelo con:** desarrollo en paralelo con todo; mergea primero.

#### R30-02 Transversal remoto: `httpToken`, rate limit, pendientes y `safePaste`
- **Rama:** `feat/remote-http-auth`.
- **FR:** E3-FR-01..05.
- **Archivos:** `SessionManager.ts` (`httpToken`, token bucket para todos los mensajes y ctl nuevos de v3.0), `RemoteManager.ts` (`resolveHttpToken`), `src/shared/sanitize-paste.ts`, mobile `safePaste.ts` (nuevos), `client.ts` (mapa de pendientes de 10 s), `store.ts`, `Composer.tsx` (envio por `safePaste`; segun D11 no hay PasteSheet, el destino es el composer en modo one-shot).
- **Schema:** usa 13.
- **Tests:** `test-remote.cjs` (rafaga de 41, `ctlAck rate`, sin strikes, `safePaste`).
- **Verificacion manual:** P-PHONE. Un prompt de 3 lineas desde el composer llega como un solo prompt. Un bundle v2.2 cacheado conecta sin `err version`.
- **Esfuerzo:** M. **Paralelo con:** R30-08, 10 (mergea antes de R30-03..07 y R30-09a).

#### R30-03 M10: imagen desde el celu
- **Rama:** `feat/mobile-image-upload`.
- **FR:** E3-FR-06..10.
- **Archivos:** `src/main/remote/UploadService.ts` (nuevo), `RemoteServer.ts` (`POST /api/upload`, CSP `blob:`, comentario del header), `RemoteManager.ts` (limpieza cada 6 h), mobile `upload.ts`, `UploadChip.tsx`, composer y `KeyBar.tsx`.
- **Schema:** usa 13. Carpeta `dataDir()/attachments`.
- **Tests:** `test-remote.cjs` (server real en puerto efimero: 401/403/400/413/415, WEBP, limpieza con `utimes`, symlinks intactos).
- **Verificacion manual:** P-PHONE. Camara, galeria, HEIC, 12 MP, 4G lento (`[Image #1]` en Claude). Portable: `attachments/` junto al exe.
- **Esfuerzo:** M. **Paralelo con:** R30-04..06.

#### R30-04 M11: modo celular (phone-fit)
- **Rama:** `feat/phone-fit`.
- **FR:** E3-FR-12..20, 22, 23. E3-FR-21 (el Chat cuenta como presencia) pasa a R30-05: este WP deja en `FitController` el estado `phone{chat}` y los hooks `ownerChat`/`ownerLeft`, y R30-05 los conecta a `chatSub`/`chatUnsub`.
- **Archivos:** `src/main/remote/FitController.ts` (nuevo), `RemoteManager.ts` (intercepta `fitPane`/`releaseFit`, reenvio despues de un reload), `PtyManager.ts` (`onResize`, fallback de replay), `SessionManager.ts` (`fitState`), IPC `remote:fitRelease`, `remoteCommands.ts`, `fitStore.ts` (nuevo), `useXterm.ts`, `MobileDriverBanner.tsx` (nuevo), `RemoteSection.tsx`, mobile `fit.ts` (`phoneGrid`), `RemoteTerminal.tsx`, `client.ts`, `store.ts`.
- **Schema:** usa 13 (`phoneFit`).
- **Tests:** `test-remote.cjs` (FitController completo con timers falsos, replay coherente con y sin emulador). `scripts/test-mobile-fit.cjs` (nuevo). `test-status-ui.cjs` (banner).
- **Verificacion manual:** P-PHONE con 2 celus. Rotacion, teclado (sin resize), Recuperar/Restaurar todas, cerrar la pestana (retenido), workspace inactivo, escala 125/150%.
- **Esfuerzo:** L. **Paralelo con:** R30-03, 06 (mergea despues de R30-01 y R30-02, antes de R30-05).

#### R30-05 M12: vista Chat
- **Rama:** `feat/mobile-chat`.
- **FR:** E3-FR-21, 24..34.
- **Archivos:** `src/main/chat/{TranscriptLocator, TranscriptWatcher, decodeClaude (MIT), decodeCodex (MIT), toolSummary, ChatHub}.ts`, `StatusManager.ts` (`transcriptFor`, `onTranscriptChange`), `src/shared/chat-types.ts`, `SessionManager.ts` (notifica `chatSub`/`chatUnsub` al `FitController` de R30-04, E3-FR-21), mobile `chat/*`, `chatStore.ts`. Dependencia `marked` 14.x (solo el lexer).
- **Schema:** sin cambio.
- **Tests:** `test-remote.cjs` (fixtures `scripts/fixtures/chat/*.jsonl`, paginas de 48 KB o menos, 50 MB en menos de 1 s, `ambiguous`/`notLocal`, dueno en Chat sin timers). `scripts/test-mobile-chat.cjs` (nuevo: XSS como texto, tools agrupadas).
- **Verificacion manual:** P-PHONE + P-NOBILL. Sesion real con Edit/Bash/permiso. Prompt multilinea desde Chat como un solo turno. Pane SSH -> `notLocal`. En modo celular, ida y vuelta a Chat sin basura y la franja del desktop dice "(Chat)".
- **Esfuerzo:** L. **Paralelo con:** R30-03, 06 (despues de R30-04).

#### R30-06 M13: historial y retomar
- **Rama:** `feat/session-history`.
- **FR:** E3-FR-36..40.
- **Archivos:** `src/main/history/SessionHistory.ts` (nuevo), IPC `sessions:list`, `SessionManager.ts` (`historyReq`), `RemoteManager.ts` (valida `createPane.resume`), `remoteCommands.ts` (rama `resume` con `setupId: ''` y `buildAgentArgv`), mobile `HistoryScreen.tsx`, `HistoryCard.tsx`.
- **Schema:** sin cambio.
- **Tests:** `test-remote.cjs` (cwd case-insensitive, precedencia, `notFound`, pane existente).
- **Verificacion manual:** P-PHONE. Retomar una sesion de ayer. Workspace con perfil SSH -> el pane corre local. Una sesion ya abierta lleva a su consola.
- **Esfuerzo:** M. **Paralelo con:** R30-03..05 (despues de R30-02).

#### R30-07 M14: HTTPS, service worker y Web Push
- **Rama:** `feat/secure-mode-push`.
- **FR:** E3-FR-42..50.
- **Archivos:** `src/main/remote/{SecureMode, PushService}.ts` (nuevos), `RemoteServer.ts`/`network.ts` (Host desde loopback, CSP `wss:`/`worker-src`, `tailscaleHttps`), `ipc-contract.ts` (`RemoteEndpoint.ip` opcional), consumidores QR/Remote, `index.ts` (push en el router de R22-18), mobile `public/sw.js`, `main.tsx`, `push.ts`, `wakeLock.ts`, `client.ts`, `KeyBar.tsx` (Pegar con `clipboard.readText`; segun D11 el fallback es el composer one-shot), manifest `id`. Dependencia `web-push` 3.6.x.
- **Schema:** usa 13 (`https`). Archivo `dataDir()/push-keys.json`.
- **Tests:** `test-remote.cjs` (PushService allowlist/404/revoke; SecureMode con un `execFile` stub que nunca llama a `funnel`).
- **Verificacion manual:** tailnet real. Aplicar/quitar `tailscale serve`, revincular en https y en la PWA de iOS, push con el celu bloqueado, update del desktop con el SW activo (una recarga), Wake Lock, `clipboard.readText`, QR con camara.
- **Esfuerzo:** L. **Paralelo con:** R30-08..13.

#### R30-08 Notas de revision en el desktop
- **Rama:** `feat/review-notes`.
- **FR:** E7-FR-17..21.
- **Archivos:** `src/main/git/ReviewNoteStore.ts`, `src/shared/review-notes-format.ts` (MIT, owner unico, forma `{file, lines, comment}`), `src/renderer/lib/submit.ts`, `reviewNotesStore.ts`, `sendReviewNotes.ts`, `changes/{NoteEditor, NoteCard, SendNotesMenu}.tsx` (nuevos), `usePaneScheduler.ts`, `store.ts` (`addPane` devuelve el id).
- **Schema:** sin cambio. Archivo `dataDir()/review-notes.json`.
- **Tests:** `test-git.cjs` (formato exacto, `sanitizeForPaste`, `not_agent` sin escrituras).
- **Verificacion manual:** P-DESK + P-NOBILL. 4 notas a Claude y a Codex, sin y con Enter. PowerShell bloqueado.
- **Esfuerzo:** M. **Paralelo con:** R30-10..13.

#### R30-09a API git remota (backend E7)
- **Rama:** `feat/git-remote-api`.
- **FR:** E7-FR-22..26.
- **Archivos:** `remote-protocol.ts` (`gitReq`/`gitRes`, `sendReviewNotes`), schemas, `SessionManager.ts` (rate + en vuelo), `RemoteManager.ts`, `index.ts`, `remoteCommands.ts` (`sendReviewNotes`). El `closePane` que conserva el worktree (E7-FR-32) vive en R30-10.
- **Schema:** sin cambio.
- **Tests:** `test-git.cjs` (paginas de 48 KB o menos, `diffRev`, `continued`, `rate`, fixtures exportados para E3).
- **Verificacion manual:** cliente WS de prueba autenticado con el desktop minimizado en el tray.
- **Esfuerzo:** M. **Paralelo con:** R30-10..13.

#### R30-09b Changes mobile (UI E3)
- **Rama:** `feat/mobile-changes`.
- **FR:** E3-FR-52..56.
- **Archivos:** `src/main/remote/GitRemote.ts` (si no quedo en 09a), mobile `changes/*`, `notesStore.ts`, `theme.ts` (ansi-green/red).
- **Schema:** sin cambio.
- **Tests:** `test-remote.cjs` (un path fuera del status da `notFound`). Test mobile con los fixtures de 09a.
- **Verificacion manual:** P-PHONE por Tailscale en un repo real con un conflicto. Anotar en el celu y mandar.
- **Esfuerzo:** M. **Paralelo con:** R30-10..13.

#### R30-10 Worktree aislado por consola
- **Rama:** `feat/worktrees`.
- **FR:** E7-FR-27..32, 36.
- **Archivos:** `src/main/git/{WorktreeService, WorktreeManifest}.ts` (nuevos), IPC `git:worktreeAdd`/`git:worktreeRemove` (contrato) + `git:worktreeInspect`/`git:worktreeList` (enmienda), `WorktreeLaunchDialog.tsx`, `WorktreeCloseDialog.tsx`, `WorkspaceView.tsx`, `PaneCell.tsx`, `TilingGrid.tsx`, `GitSection.tsx`, `PtyManager.ts` (`cwd_missing`), `remoteCommands.ts` (`closePane` remoto conserva el worktree, E7-FR-32).
- **Schema:** usa 13 (`worktreesRoot`, `pane.worktree`). Archivo `dataDir()/worktrees.json`.
- **Tests:** en `test-git.cjs`, crear con `.env` + junction, borrar sin seguir el junction (archivo centinela), `branch_exists` intacta, rollback parcial, `not_managed`, huerfanos, `closePane` remoto que conserva la carpeta y la rama.
- **Verificacion manual:** repo Node real. `npm test` dentro del worktree, borrar sucio con la confirmacion y `node_modules` original intacto. Portable. Ruta larga. Borrar la carpeta a mano -> tarjeta de FR-36. `closePane` desde el celu deja carpeta y rama.
- **Esfuerzo:** L. **Paralelo con:** R30-08, 11..13 (mergea despues de R30-01).

#### R30-11 CLI `snaos` y skill
- **Rama:** `feat/cli-snaos`.
- **FR:** E8-FR-12..22. Clave `settings.cliEnabled` del contrato. IPC `cli:setEnabled` del contrato. Se reusa `remote:controlCmd` para open/spawn/send.
- **Archivos:** `src/main/cli/{CtlServer, CtlTokens, runtimeFile, shim, userPath, handlers, rendererBus, agentGuide, skillInstaller, cliEntry}.ts`, `src/shared/{ctl-protocol, ctlRefs, ansi}.ts` (nuevos), `electron.vite.config.ts` (entrada `cli`), `shellResolver.ts`, `PtyManager.ts` (`envProvider`, `tail`), `StatusManager.ts` (`notifyCustom`), `events.ts`, `DiscordNotifier.ts`/`NtfyNotifier.ts` (kind `custom`), `ctlCommands.ts`, `AutomationSection.tsx`, `build/installer.nsh` (`customUnInit`, D7).
- **Schema:** usa 13. Archivos `dataDir()/runtime.json` y `dataDir()/bin/snaos.cmd`.
- **Tests:** `test-automation.cjs` (CtlServer sobre un pipe temporal: 401/403/413, token de consola, `wait` con `noTurnObserved`, 32 waiters, rate de `notify`; `cliEntry`; shim ejecutado con el Electron del repo; `userPath` con registro inyectado; skill en un `CLAUDE_CONFIG_DIR` temporal).
- **Verificacion manual:** P-DESK en PowerShell 5.1, pwsh y cmd. `snaos ls`, `send` con acentos, `Get-Content | snaos send 2 -`, `send --enter && wait --idle` (P-NOBILL), Ctrl+C durante `wait`. Skill: "abri un codex y que revise el diff". Portable: con la app cerrada, el shim sale con 5.
- **Esfuerzo:** L. **Paralelo con:** R30-08..10, 12, 13.

#### R30-12 `.snagentsos.json` por repo
- **Rama:** `feat/repo-config`.
- **FR:** E8-FR-23..27.
- **Archivos:** `src/main/repoConfig/{schema, repoConfig, TrustStore}.ts`, `registerRepoConfigIpc.ts` (nuevos), IPC `repoConfig:read`/`trust`/`export` (contrato) + `previewExport` (enmienda), `RepoConfigCard.tsx`, `TrustDialog.tsx`, `ExportRepoConfigDialog.tsx`, `renderer/lib/repoConfig.ts`, `store.ts` (`heldPanes`), `PaneCell.tsx`, `Sidebar.tsx`.
- **Schema:** usa 13. Archivo `dataDir()/trusted-repos.json`.
- **Tests:** `test-automation.cjs` (cwd que escapa por junction/UNC/`C:foo`, hash estable ante BOM/CRLF, `needsTrust` con solo perfil, ida y vuelta export -> draft).
- **Verificacion manual:** repo real con `pnpm install` como setup y `waitForSetup`. Editar el archivo vuelve a pedir trust. Un perfil local real muestra su linea.
- **Esfuerzo:** M. **Paralelo con:** R30-08..11, 13.

#### R30-13 Automatizaciones recurrentes
- **Rama:** `feat/recurring-automations`.
- **FR:** E8-FR-28..31 y la parte desktop de FR-32.
- **Archivos:** `src/shared/schedule.ts` (nuevo), `usePaneScheduler.ts` (`decide`, montaje parcial), `ScheduleDialog.tsx`, `PaneCell.tsx` (reloj activo/pausado), `AutomationSection.tsx` (tabla).
- **Schema:** usa 13 (campos de `PaneSchedule`).
- **Tests:** `test-automation.cjs` (`nextDue` con DST y `TZ` fijo, tabla de `decide`, historial acotado a 20).
- **Verificacion manual:** "cada hora" con la PC suspendida 2 h. "Lun-Vie". Una automatizacion en un workspace no visitado de 4 consolas arranca solo una.
- **Esfuerzo:** M. **Paralelo con:** R30-08..12 (mergea antes de R30-14 por `usePaneScheduler.ts`).

#### R30-14 Hibernacion, tablero y timer de cache
- **Rama:** `feat/agent-hibernation`.
- **FR:** E5-FR-25..28. D3.
- **Archivos:** `src/main/agents/Hibernation.ts` (header MIT si adapta el planner), `SessionManager.ts` (`subscribedPaneIds`), `remoteCommands.ts` (wake con `resume:true`), `SleepingOverlay.tsx`, `AgentsBoard.tsx` (Ctrl+Shift+A, enmienda), `CacheChip.tsx`, `usePaneScheduler.ts` (wake por schedule sobre el `decide` de R30-13), chip de cache en mobile (localStorage `snagentsos.cacheTimer`).
- **Schema:** usa 13 (`hibernateIdleMinutes`, `agents.cacheTimer`).
- **Tests:** `test-agents.cjs` (planner: 2 ticks, `lastInputAt`, exclusiones, maximo 3 por tick, kill explicito).
- **Verificacion manual:** P-DESK con N=5. Un prompt a medio escribir no duerme. Despertar desde el celu. RAM en `SYSTEM_METRICS`. Reinicio con un pane dormido.
- **Esfuerzo:** M. **Paralelo con:** R30-08..12.

#### R30-15 Carrera por etapas (P2, ultimo bloque)
- **Rama:** `feat/agent-race`.
- **FR:** E7-FR-33..35.
- **Archivos:** `GlobalPromptDialog.tsx`, `broadcastPrompt.ts` (`pasteToPane` + Enter opcional), `race.ts`, `RaceBar.tsx` (nuevos).
- **Schema:** sin cambio.
- **Tests:** `test-git.cjs` (diffstat contra base). `test-git-ui.cjs` (RaceBar).
- **Verificacion manual:** Claude x1 + Codex x1 en worktrees (P-NOBILL). Ninguna accion hace merge.
- **Esfuerzo:** M. **Paralelo con:** nada, va al final. Si v3.0 se atrasa, las etapas B y C pasan a v3.1.0 (nunca "v3.x").

#### R30-16 Release v3.0.0
- **Rama:** `release/v3.0.0`.
- **Contenido:** bump. Notas con las rutas HTTP nuevas, la re-vinculacion en https y el modelo de seguridad del CLI. Update 2.2 -> 3.0. `PROTOCOL_VERSION` sigue en 1.
- **Esfuerzo:** S.

**PRs de v3.0.0:** un PR por WP. R30-09a y R30-09b son dos PR separados (backend primero).

---

### v3.1.0: Pendientes aprobados "mas adelante"

Arranca desde `main` con v3.0.0 publicado. El primer WP sube el schema a 14 y cierra las enmiendas al contrato que necesitan los FR de celu de E8.

#### R31-00 Schema 14 y enmiendas v3.1
- **Rama:** `feat/config-v14`.
- **FR:** claves y contrato de v3.1:
  - Clave `settings.terminalShellIntegration` (default `true`, con `.catch`).
  - Enmiendas WS: `RemoteWorkspaceInfo.note?`/`taskState?` (E8-FR-11), `RemotePaneInfo.statusLine?` (E8-FR-19), `RemoteStateSnapshot.schedules?` + ctl `scheduleRun`/`scheduleToggle` (E8-FR-32).
  - Redaccion en el PRD E2 de E2-FR-53 ("Permitir siempre" = "2") y E2-FR-54 (tarjeta de Plan), con sus AC, antes de empezar R31-03.
- **Archivos:** `types.ts`, `schema.ts`, `store.ts`, `remote-protocol.ts`, `remote-protocol-schemas.ts`.
- **Schema:** 13 -> 14 (sin logica).
- **Tests:** `test-automation.cjs` (v13 -> v14 conserva todo), zod de los ctl nuevos.
- **Verificacion manual:** P-DESK con una config v13 real.
- **Esfuerzo:** S. **Paralelo con:** desarrollo en paralelo; mergea primero.

#### R31-01 Shell integration de PowerShell
- **Rama:** `feat/pwsh-shell-integration`.
- **FR:** E6-FR-25..31.
- **Archivos:** `src/main/pty/powershellIntegration.ts` (nuevo, header MIT), `PtyManager.ts` (args `-EncodedCommand`, `SNAOS_SHELL_INTEGRATION=1`, `stripOsc133` en `waitFor`, ready-marker), `src/renderer/components/terminal/shellMarks.ts` (nuevo), `useXterm.ts` (`controller.prompt`, `copyLastOutput`), `keymap.ts` (`promptPrev`/`promptNext` en Ctrl+Shift+PageUp/PageDown, libres por D8), `useGlobalKeys.ts`, `PaneCell.tsx` ("Copiar salida del ultimo comando"), `TerminalSection.tsx` (toggle).
- **Schema:** usa 14 (`terminalShellIntegration`).
- **Tests:** `test-terminal-engine.cjs` (`buildIntegrationArgs` decodifica a un script con `133;A`, `FullLanguage` y `UTF8Encoding($false)`; solo PowerShell sin args; `stripOsc133` con `waitFor` anclado).
- **Verificacion manual:** perfil real del usuario (oh-my-posh si lo usa): prompt intacto, marcas, Ctrl+Shift+PageUp/PageDown, barra roja de error, copiar la salida, `[Console]::OutputEncoding.CodePage` = 65001. SSH Profile con `waitFor` anclado. ConstrainedLanguage en VM no rompe nada.
- **Esfuerzo:** M. **Paralelo con:** R31-02, 03.

#### R31-02 Nota, statusLine y automatizaciones en el celu
- **Rama:** `feat/mobile-automation-surface`.
- **FR:** E8-FR-11, la parte de celu de E8-FR-19 (statusLine) y la parte de celu de E8-FR-32 (seccion Automatizaciones con switch Activa y "Probar ahora").
- **Archivos:** `remoteSnapshot.ts` (note, taskState, statusLine, schedules), `remoteCommands.ts` (executor de `scheduleRun`/`scheduleToggle`, que reusa el camino "Probar ahora" de R30-13), mobile Home/Terminal (linea de nota y statusLine), `AutomationsScreen.tsx` (nuevo), i18n mobile.
- **Schema:** usa 14 (contrato de R31-00).
- **Tests:** `test-remote.cjs` (snapshot con los campos nuevos, ctl de schedule con pertenencia validada). `test-mobile-ui.cjs` (nota truncada, lista de automatizaciones).
- **Verificacion manual:** P-PHONE. Nota visible en el Home, statusLine de `snaos status` en el header de la terminal, "Probar ahora" desde el celu sin mover la proxima ejecucion.
- **Esfuerzo:** M. **Paralelo con:** R31-01, 03.

#### R31-03 M7 extras: "Permitir siempre" y tarjeta de Plan
- **Rama:** `feat/mobile-prompt-cards-extra`.
- **FR:** E2-FR-53, E2-FR-54 (nuevos, redactados en R31-00 a partir del item diferido de M7 en la sintesis).
- **Archivos:** mobile `promptRules.ts` (pedidos `plan`), `answer.ts` (grupo "2" para Permitir siempre), `prompts/PermissionCard.tsx`, `prompts/PlanCard.tsx` (nuevo). Desktop sin cambios de contrato (`pending[]` ya trae `plan`).
- **Schema:** sin cambio.
- **Tests:** `test-mobile-ui.cjs` (boton "Permitir siempre" manda "2" sin `\r`; tarjeta de Plan solo con el layout validado; fallback a la tira si cambia la version de Claude).
- **Verificacion manual:** P-PHONE + P-NOBILL con Claude Code de la version vigente: Permitir siempre y aprobar/rechazar un plan real. Si el layout del menu de Claude no coincide, el WP se cierra con la tira y queda documentado.
- **Esfuerzo:** S-M. **Paralelo con:** R31-01, 02.

#### R31-04 Release v3.1.0
- **Rama:** `release/v3.1.0`.
- **Contenido:** bump, notas (shell integration y como apagarla) y update 3.0 -> 3.1. Si la carrera B/C salio de v3.0, entra aca como WP previo.
- **Esfuerzo:** S.

---

### v3.x: backlog sin agendar (fuera de la sintesis)

- E3 `manualCert`.
- Chip de fin de sesion para Codex (cuando CodexBridge exponga el fin de thread).
- `precise`/`serverTime` si no se aprobaron en v2.1.
- Sincronizacion de notas entre celu y desktop, `RemotePaneInfo.local`, `gitReq.paneId` + rama de worktree en el celu.

Cada item necesita su FR y el alta en Contratos compartidos antes de agendarse.

## Estrategia de pruebas global

**Capas:**
1. **`npm test` (node puro, rapido, en `ci.yml` y en cada pierna de `release.yml`).** Esbuild + `vm` + `check()`, temporales en `os.tmpdir()`, sin red real y sin config del usuario. Se encadena por release:
   - v2.0: `test-status.cjs`, `test-rebrand.cjs` (nuevo), `check-brand.cjs` (nuevo; marca vieja + em/en dash).
   - v2.1: `+ test-remote.cjs`, `test-mobile-logic.cjs`, `test-agents.cjs`, `test-terminal-engine.cjs`, `test-desktop-comfort.cjs`, `test-git.cjs` (todos nuevos).
   - v2.2: `+ test-automation.cjs`. Se extienden los anteriores.
   - v3.1: se extienden `test-terminal-engine.cjs`, `test-remote.cjs` y `test-automation.cjs`.
   - Script agregador en `package.json`: `"test": "node scripts/run-tests.cjs"` (nuevo), que corre la lista y resume los `PASS: N` de cada suite. Asi no queda una cadena `&&` de 10 entradas.
2. **`npm run test:electron` (nuevo agregador, ventanas Electron ocultas con perfil temporal; requiere `npm run build`).** En `ci.yml` se corre con `xvfb-run -a`:
   - `test-status-ui.cjs` (hoy fuera de CI; entra en v2.0) y `test-mobile-scroll.cjs` (existentes, extendidos).
   - `test-mobile-ui.cjs` (v2.1, E1/E2), `test-terminal-ui.cjs` y `test-mobile-terminal.cjs` (v2.1), `test-git-ui.cjs` (v2.2), `test-automation-ui.cjs` (v2.2), `test-mobile-chat.cjs` y `test-mobile-fit.cjs` (v3.0).
   - Cada suite saca capturas en tema claro y oscuro y a 100/125/150%.
3. **`npm run typecheck`** (node, web y mobile). Las claves i18n tipadas obligan la paridad es/en.
4. **Fuera del gate:** `npm run bench:terminal` (v2.2), con el resultado registrado en el PR de R22-07 y en las notas de release.

**Reglas:**
- Cada WP agrega sus checks a la suite indicada y no baja el conteo de `PASS` existente.
- Los fixtures de protocolo que consume otro epic se exportan desde la suite del owner. Por ejemplo, `RemoteGitChanges` lo exporta `test-git.cjs` para E3.
- Nada de red real: Discord, ntfy, push y GitHub se prueban contra endpoints locales o stubs.
- La deteccion de mojibake (`[char]0x00E2+[char]0x201D`) se suma a `check-brand.cjs` sobre los archivos trackeados.
- Los manuales siguen P-DESK / P-PHONE / P-LEGACY / P-NOBILL, y su resultado se registra en el PR como checklist.

**CI resultante (`ci.yml`):** `npm ci` -> `typecheck` -> `npm test` -> `build` -> `xvfb-run -a npm run test:electron`. `release.yml` sigue con `typecheck` + `npm test` por OS antes de empaquetar.

## Proceso de release

Igual para v2.0.0 en adelante, salvo lo marcado como "solo v2.0.0".

1. **Merges:** todos los PR de la release en `main` con CI verde y el checklist manual del WP completo.
2. **Rama de release** con P-WT, siguiendo la regla global de no commitear en la rama default: `git worktree add ..\snaos-wt\release -b release/vX.Y.Z origin/main`.
   - `npm version X.Y.Z --no-git-tag-version` (actualiza `package.json` y `package-lock.json`).
   - Verificar `CONFIG_VERSION` contra la tabla del contrato (10/11/12/13/14).
   - Escribir `docs/release-notes/vX.Y.Z.md` en espanol: novedades, migraciones, cambios de comportamiento, checklist de mojibake si aplica y atribuciones a Orca.
   - Local: `npm run typecheck`, `npm test`, `npm run build`, `npm run test:electron` y `npm run dist:win` (smoke del setup y la portable en VM).
   - Commit `chore: release vX.Y.Z` (con la linea Co-Authored-By de la sesion) -> PR -> merge.
3. **Tag:** `git checkout main && git pull`, despues `git tag vX.Y.Z` y `git push origin vX.Y.Z`. Los tags de ensayo llevan `-rc.N` y salen como prerelease.
4. **CI (`release.yml` post FR-21):** la matriz windows-2022/macos/ubuntu sube a un release **draft** (invisible para el updater). `release-notes` verifica 16 assets + un `.sha256` por distribuible y recien ahi publica con el titulo "SnAgentsOS vX.Y.Z" y el cuerpo desde `docs/release-notes/vX.Y.Z.md` + el changelog generado.
5. **Chequeo de salud (16 assets):**
   ```powershell
   gh run list --workflow=release.yml --limit 3
   gh release view vX.Y.Z --json isDraft,isPrerelease,assets --jq '{d:.isDraft,p:.isPrerelease,n:(.assets|length)}'   # esperado d:false p:false n:16
   gh api repos/ValentinTarnovsky/SnAgentsOS/releases/latest --jq .tag_name                                          # esperado vX.Y.Z
   ```
   - Set de assets sano: `SnAgentsOS-X.Y.Z-setup.exe`, `-portable.exe`, `.dmg`, `-arm64.dmg`, `-mac.zip`, `-arm64-mac.zip`, `.AppImage` y `snagentsos_X.Y.Z_amd64.deb`, cada uno con su `.sha256`.
   - Falla real = run `failure` + release en draft. Se corrige y se re-dispara con `workflow_dispatch` sobre el mismo tag. No se crea un tag nuevo.
   - Ningun epic agrega assets: el CLI vive en el asar y el shim se genera en runtime. Las 16 son un invariante.
6. **Verificacion post-publicacion:** "Buscar actualizaciones" desde la version anterior, instalada y portable (VM), con SHA-256 verificado. Solo v2.0.0: es W12 y los dos caminos cierran con el chequeo "sin restos" de E0 (sin `Programs\SnMultiCC`, sin `%APPDATA%\snmulticc`, portable renombrada a `SnAgentsOS-portable.exe`, zip presente y marcador en `done`). Ademas, sobre el setup publicado, `SNAOS_TEST_FAULT=verify` no tiene efecto (el define `__SNAOS_TEST_FAULTS__` es falso en el release).
7. **Rollback de emergencia:** `gh release edit vX.Y.Z --prerelease`, y `latest` vuelve a la anterior. El hotfix sale como `vX.Y.Z+1`. Solo v2.0.0: esto frena la distribucion pero **no devuelve a nadie a 1.x**. Volver a 1.x no esta soportado (E0 R7): quien ya migro tiene su carpeta vieja borrada y se queda en 2.x; el hotfix sale como 2.0.1. La recuperacion de datos ante un desastre es `migration-backup-v1.zip` durante 30 dias (W11).
8. **Puente de nombres legados (solo v2.0.0):**
   - La 1.14.1 elige el asset por patron (`setup`, `portable`, `.dmg` + arch, `.AppImage`, `.deb`) y no por prefijo de producto. No hace falta publicar assets con nombres `SnMultiCC-*`.
   - La 1.14.1 apunta a `repos/ValentinTarnovsky/SnMultiCC/releases/latest`. Despues del rename, GitHub responde 301 hacia `api.github.com/repositories/<id>/...`, que esta dentro de la allowlist del updater. Se valida en W0 **antes** del tag.
   - Regla permanente: nunca crear otro repo `SnMultiCC` en la cuenta, porque romperia la redireccion de todos los clientes 1.x.
   - Instalada: el setup 2.0.0 instala en `Programs\SnAgentsOS` y desinstala solo `Programs\SnMultiCC` con el desinstalador viejo (E0-FR-15); la app borra los datos y demas restos despues de verificar y confirmar (E0-FR-27..34).
   - Portable: el swap de 1.14.1 (ya publicado) escribe la 2.0.0 sobre el archivo viejo (`SnMultiCC-1.14.1-portable.exe`). En su primer arranque la 2.0.0 se renombra a `SnAgentsOS-portable.exe`, borra los hermanos `SnMultiCC-x.y.z-portable.exe` y redirige los accesos directos hechos a mano hacia el `.exe` viejo (E0-FR-33, Q10 invertida: antes se conservaba el nombre). Los updates 2.x siguientes conservan `SnAgentsOS-portable.exe`. La portable no registra accesos directos propios.
   - mac: la app mueve `SnMultiCC.app` a la Papelera sola (si falla por permisos, el aviso pide hacerlo a mano). Linux: el AppImage viejo lo reemplaza el swap y, si su nombre contiene `snmulticc`, se renombra; el `.deb` viejo necesita root y solo se documenta `sudo apt remove snmulticc` (E0 L21).
   - Las reglas de firewall de `SnMultiCC.exe` no se borran (exigen UAC) y quedan inertes (E0 Q12).
   - **Contingencia v1.14.2:** solo si W1 falla aun con `snPrepareUpgrade`. Se corta `release/v1.14.2` desde el tag `v1.14.1` con el workflow viejo (globs `SnMultiCC-*`). Cambia solo `applyInstall`: con salto de version mayor, sale limpio. Se publica como `latest` y se espera la adopcion antes de publicar v2.0.0.
9. **Memorias (despues de v2.0.0):** actualizar `release-workflow-midbuild-appearance` (draft hasta 16, sin ventana visible) y `runtime-testing-singleinstance-gotcha` (dev aislado en `snagentsos-dev`). Este documento no las modifica.

## Riesgos del programa y mitigaciones

| # | Riesgo | Mitigacion |
|---|---|---|
| 1 | El rebrand pierde datos o deja celus sin emparejar o hooks huerfanos. Desde la decision "todo automatico" es el riesgo principal: la carpeta vieja se borra sola y volver a 1.x no esta soportado | Verificar antes de borrar: staging, SHA-256 por archivo, schemas zod, config efectiva igual, `configStore.load()` real, conteos iguales y re-hash antes del commit (E0-FR-27). Nada legado se borra sin el marcador en `committed` (FR-29). Borrado en dos pasos con tombstone, copia `prev` del marcador y modo conservador si se corrompe. Red de seguridad unica: `migration-backup-v1.zip` verificado entrada por entrada, borrado solo a los 30 dias (FR-28). Falla = no borrar, banner y reintento (FR-35). `remote-devices.json` obligatorio. W1/W3/W5/W10/W11/W15/W16 bloqueantes en VM. Contingencia v1.14.2 |
| 2 | Upgrade NSIS lado a lado, colgado, anidado en la carpeta vieja o que se mata a si mismo | `nsis.guid` legado + `snPrepareUpgrade` (redirect a `Programs\SnAgentsOS` en `customInit` con `/S` y en la pagina oculta `customPageAfterChangeDir`, `SHCTX`, `taskkill` sin `/T` porque el setup es hijo de `SnMultiCC.exe`). Test de consistencia de `installer.nsh`. W1 con el desinstalador roto, con `/S` y con carpeta personalizada, W18 y W20 |
| 3 | Redireccion de GitHub rota | W0 antes del tag y regla de no reusar `SnMultiCC` |
| 4 | v2.1 y v2.2 demasiado grandes (15 y 20 WP) | Grafo con paralelismo explicito. Corte v2.1.1 permitido para R21-13/14 despues de R21-10, y v2.2.1 para R22-07/08. Los WP mobile y desktop son independientes salvo R21-02 y R22-12 |
| 5 | Contencion en archivos calientes (`StatusManager`, `PtyManager`, `RemoteManager`, `store.ts`, `updater.ts`, `usePaneScheduler.ts`) | Orden de merge fijo por release (schema -> enriquecimiento -> resto, y los ordenes explicitos de cada seccion), rebase obligatorio antes del merge y PR chicos |
| 6 | Arbol de trabajo compartido por varias consolas | P-WT (worktree por WP), nunca `git checkout -b` en el arbol comun |
| 7 | Deriva entre PRD y contrato (numeracion de owners, canales git, atajos, claves, PasteSheet) | Tabla de correspondencia, D1-D12 y la lista de enmiendas de abajo. Cada enmienda se cierra antes de empezar su WP |
| 8 | Dos bumps de schema en una release, o un WP que mergea antes del schema | El primer WP de la release (R21-01, R22-01, R30-01, R31-00) agrega todas las claves con defaults de zod y mergea primero. Los demas WP no tocan `CONFIG_VERSION` |
| 9 | Regresion de mojibake (Unicode11, headless) | Canvas default intocable, xterm y addons pineados exactos, checklist manual firmado en v2.1 y v2.2 |
| 10 | Costo del headless en main | Bench con presupuesto, default `lazy` como plan B y kill switch `off` |
| 11 | Enter automatico en el lugar equivocado (QC, CLI, notas, automatizaciones) | Gate con senal precisa, `multiline_unsafe` sin bracketed paste, Enter solo opt-in. Tests de `submit` |
| 12 | Cambios en la TUI de Claude o Codex (tarjetas, resume, slug de proyectos, menu de plan) | Datos de hooks y no de pantalla, tira "abrir terminal" como salida, verificacion por release con Claude 2.1.x, `promptCards` desactivable. R31-03 se cierra con la tira si el layout no coincide |
| 13 | Seguridad de superficies nuevas (HTTP upload, CLI por pipe, `openPath`, `.snagentsos.json`, firewall elevado, worktree remove) | Bearer por sesion, tokens por consola, contencion por `realpath`, allowlists inertes, trust por hash en main, validacion contra el manifiesto. Tests negativos en cada suite |
| 14 | Prompt de firewall repetido por cambio de exe o de ruta | Una sola vez en v2.0 (aviso de FR-10). `unpackDirName` estable y la ruta nueva `Programs\SnAgentsOS` fija desde v2.0. Las reglas viejas de `SnMultiCC.exe` quedan inertes y no se borran (exigen UAC, E0 Q12). Chequeo por ruta de programa en M9 |
| 15 | Atajos Ctrl+Alt+flechas chocan con AltGr o con la rotacion de Intel | Remapeables, prueba con teclado es-latam en R21-05, documentado |
| 16 | Licencia Orca | `THIRD_PARTY_NOTICES.md` antes del primer archivo portado (R21-00 o E0), header de una linea por archivo adaptado. No usar la marca |
| 17 | Flakiness de suites Electron en CI (xvfb) | Agregador `test:electron` con un reintento unico por suite y capturas como artefacto del job |
| 18 | `installer.nsh` compartido por tres epics | D7 y test de presencia de todas las macros (las tres de E0, `customUnInstall` y `customUnInit`) mas los chequeos de `/T`, `SHCTX` y `Pop` |
| 19 | Celus con bundle viejo despues de cada update | `PROTOCOL_VERSION` fijo en 1, adiciones aditivas, pantalla "Actualizado" (M2) desde v2.1 |
| 20 | La limpieza automatica borra algo que no es nuestro | Lista blanca de rutas calculadas en main (inventario L01-L21), guardas de contencion contra `dataDir()`, `userData`, la carpeta del exe y raices del sistema, `safeRemoveTree` que no sigue symlinks ni junctions, residuo de instalacion solo con layout de electron-builder, `.exe` portables solo con patron exacto, entradas desconocidas al zip o la carpeta no se borra. Tests en R20-04 con arbol falso, snapshot antes/despues y junction centinela (E0 R10) |
| 21 | Un build empaquetado abierto en la maquina del desarrollador migra y borra su `%APPDATA%\snmulticc` y su 1.14.1 reales | P-LEGACY bloqueante: empaquetados solo en VM o usuario aparte; en dev la limpieza es simulacion salvo `SNAOS_FORCE_LEGACY_CLEANUP=1` con arbol falso completo (E0 R16). La instalacion propia del desarrollador se actualiza recien despues de W12 |
| 22 | Restos que la app no puede borrar sola: archivos en uso indefinidamente, 1.x per-machine con 2.0 "Solo para mi", `SnMultiCC.app` sin permisos, pin desfijado por el desinstalador viejo | Items `deferred` con reintentos (60 s, 5 min, cada arranque) y banner a los 5 arranques; sin `MoveFileEx` diferido ni UAC. `skipped: needsElevation` con accion concreta en el aviso (`manualActions`). Pin: se redirige si sigue vivo; si no, el aviso pide re-fijar (Windows 10+ no permite fijar por programa). W1 en Windows 10 y 11, W15, W18 (E0 R11, R12, R14) |
| 23 | Datos de una portable guardados dentro de la carpeta que borra el desinstalador viejo | `snGuardPortableData` detiene el setup antes de desinstalar (unica detencion manual del flujo). README lo advierte. W19 (E0 R15) |

**Enmiendas a Contratos compartidos (cerrar antes del WP indicado):**
- **v2.0 (antes de R20-02, R20-04 y R20-05), por la limpieza automatica de E0:**
  - Archivos reservados en `dataDir()`: `legacy-migration.json` (marcador v2 con `phase`, `outcome`, `sources`, `verified`, `backup`, `postCommitBackup`, `cleanup` por L-id, `cleanupStarts`, `hooksMigration`, `loginItemMigrated`, `pinRetargeted`, `portableExeRenamedTo`, `noticeSeen`), `legacy-migration.prev.json`, `legacy-migration.json.corrupt-*`, `.legacy-staging/`, `pre-import/` (primera + 2 mas nuevas), `migration-backup-v1.zip` (grupos `other/` y `post-commit/<ISO>/`) y `logs/legacy-migration.log`; tombstones `<legacy>.deleting-*`.
  - IPC `app:legacyInfo`, `app:legacyAck`, `app:legacyShowBackup`, `app:legacyOpenLog` y evento `app:legacyStatus` (`LegacyDataInfo.manualActions`). Se dan de baja `app:legacyOpenDir`, `app:legacyImport` y `app:legacyCleanup`.
  - Valores de registro `LegacyInstallLocation` y `LegacyTaskbarPinned` en `SHCTX\Software\<GUID>`.
  - Variables `SNAOS_FORCE_LEGACY_CLEANUP` y `SNAOS_TEST_FAULT` (esta solo con `__SNAOS_TEST_FAULTS__`).
  - i18n: fuera `settings.data.legacy.*`; nuevas `settings.data.backup.*` y `legacy.banner.*`. Schema sin cambio (v10).
- **v2.1 (R21-00):**
  - `RemotePaneInfo.resumable?` (D10).
  - `RemotePaneStatus.precise?` (recomendado).
  - `RemoteStateSnapshot.terminalUnicode`, `replay.exitCode`, `RemotePaneInfo.exitCode`.
  - IPC `pty:restart`, `status:sessionEnd`, `agents:*` y los campos desktop-only de `PaneStatus` (`detail`, `topic`, `firstPrompt`, `cacheSince`).
  - Claves `notifications.inAppWhenFocused`, `settings.agents.*` (v11), `workspaces[].agentsCollapsed`, `terminalAgentEndChip`.
  - Storage `snagentsos.alerts.inPage` y sessionStorage `snagentsos.reloadFor`.
  - Atajos segun D8.
- **v2.2 (R22-01):**
  - Snapshot `hostName`, `mountedWorkspaceIds`. ctl `mountWorkspace`, `revealPane`, `openUrl`, `agentResume` (E6-FR-24, R22-20) y la marca de sesion terminada que consume la franja del celu. `ctlAck.promptFallback`. C->S `visibility`.
  - IPC `window:reveal`, `remote:openNetworkSettings`, `update:getState`/`update:state`, `pty:killPanes`, `pty:reconcile`, `pty:submit`, `pty:promptResult`, `pty:setEngine`, `scrollback:*`, `app:reload`, `app:reportRenderError`, `app:takePendingOpen`, `system:getExplorerMenu`, extras git (D6).
  - Cambio de forma de `system:setExplorerMenu` (objeto) y `app:rendererRecovered` -> `app:takeRecovery` (pull).
  - Claves `terminalSnapshotMode`, `settings.agents.*` (v12), `automation.defaultAgentPresetId`/`composerCreateAnother`, `workspaces[].note`/`taskState`.
  - Storage `snagentsos.prefs` y `snagentsos.lastViewed`.
- **v3.0 (R30-01):**
  - `repoConfigTrust` pasa a un archivo main-owned `dataDir()/trusted-repos.json` (el renderer no puede forjar el trust).
  - `automations` top-level se reemplaza por `PaneSchedule` extendido.
  - `settings.automation.cli*`/`schedule*`, `settings.agents.cacheTimer`, `workspaces[].repoConfig`.
  - IPC `repoConfig:previewExport`, `git:worktreeInspect`/`List`, `agentsBoard` Ctrl+Shift+A.
  - Storage `snagentsos.remote.*` de E3 y `snagentsos.cacheTimer`.
  - D11: E3-FR-05 y E3-FR-48 reemplazan PasteSheet por el composer en modo one-shot.
- **v3.1 (R31-00):**
  - Clave `settings.terminalShellIntegration` (schema 14).
  - `RemoteWorkspaceInfo.note?`/`taskState?`, `RemotePaneInfo.statusLine?`, `RemoteStateSnapshot.schedules?`, ctl `scheduleRun`/`scheduleToggle`.
  - FR nuevos E2-FR-53 (Permitir siempre) y E2-FR-54 (tarjeta de Plan) en el PRD E2.

## Checklist de arranque

Primeras 10 acciones para empezar v2.0.0:

1. Congelar las decisiones de E0 segun la decision final del usuario ("todo automatico: migrar todo SnMultiCC y borrar lo viejo"): instalacion movida a `Programs\SnAgentsOS` con la vieja desinstalada por el setup (Q1), datos legados borrados solos despues de verificar y confirmar (Q2), un unico `migration-backup-v1.zip` con vencimiento fijo de 30 dias (Q14), sin boton manual (FR-11 retirado) y **sin rollback a 1.x**, portable renombrada a `SnAgentsOS-portable.exe` (Q10), reglas de firewall viejas sin tocar (Q12), pin redirigido que conserva su nombre de archivo (Q13), sin v1.14.2 salvo falla de W1 (Q3), sin `--replaces` en el deb (Q9) y sin renombrar la carpeta local del repo (Q4). Fijar como contrato v2.0 los valores de `src/shared/brand.ts`, `BACKUP_TTL_MS` y los nombres de valor de registro `LegacyInstallLocation`/`LegacyTaskbarPinned`, y cerrar las enmiendas v2.0 de Contratos compartidos.
2. Preparar el entorno de prueba bloqueante (P-LEGACY; nunca la maquina del desarrollador, que tiene la 1.14.1 real):
   - VMs con snapshot en Windows 10 y Windows 11, con SnMultiCC 1.14.1 instalada "solo para mi" y una portable con `snmulticc-data`: 2 workspaces, hooks instalados (y `settings.json.snmulticc.bak`), Codex activo, `launchOnStartup`, icono fijado en la barra, acceso directo de escritorio, `closeToTray` con consolas abiertas y un celu emparejado por LAN y Tailscale (fixture de W1/W3/W5/W12).
   - Un snapshot aparte con 1.14.1 instalada "para todos los usuarios" en `Program Files` (W18).
   - Exportar un `snmulticc-fixture` para P-LEGACY y los tests de R20-04: config + 14 backups + devices, un archivo desconocido, un archivo de solo lectura y una junction hacia una carpeta centinela.
   - Anotar la lista "sin restos" del plan de pruebas de E0 como checklist reutilizable para cada W.
3. Crear la rama de integracion desde `main`: `git worktree add ..\snaos-wt\rebrand -b feat/rebrand-snagentsos origin/main` y publicarla (`git push -u origin feat/rebrand-snagentsos`).
4. Ejecutar R20-01: `src/shared/brand.ts`, reemplazo de cadenas visibles y del unico en dash (`UsageRing.tsx`), esqueleto de `scripts/test-rebrand.cjs`. PR a la rama de integracion.
5. Abrir en paralelo, con worktrees propios, R20-02 (empaquetado + `installer.nsh`), R20-03 (env + hooks), R20-06 (updater), R20-07 (auth mobile) y R20-08 (release en draft).
6. En R20-08, correr el ensayo W14 con `workflow_dispatch` y el tag `v2.0.0-rc.1` (prerelease). Confirmar que las 3 piernas comparten un solo draft y que `latest` no se mueve. Si no, aplicar el fallback de `prepare` + `gh release upload --clobber`. Borrar el release y el tag de ensayo.
7. Ejecutar R20-04 (marcador v2, pipeline con verificacion, zip, motor de limpieza L01-L21, `dataDir()`, dev aislado y `DeviceRegistry` perezoso) despues de R20-03, y validarlo con P-LEGACY sobre arbol falso antes de pasar a la VM.
8. Ejecutar R20-05 (aviso con estado de la limpieza y zip, banners de FR-35, linea del respaldo en Ajustes > Datos; sin bloque "Datos de SnMultiCC") y R20-09 (README con "Antes SnMultiCC": limpieza automatica, zip de 30 dias y recuperacion, rollback no soportado, pin, per-machine y portable fuera de la carpeta de instalacion; `docs/release-notes/v2.0.0.md`; `check-brand.cjs` con la guarda de dashes) y encadenar `npm test`. Ya no hay decision sobre E0-FR-11: esta retirado y R21-16 tambien.
9. R20-10: `npm run dist:win` desde la rama de integracion mas el build de prueba con `__SNAOS_TEST_FAULTS__`. Corrida completa en las VMs de Windows 10 y 11 de W1 (asistente, desinstalador roto, `/S`, carpeta personalizada; registrar el pin), W2, W3, W4, W5, W6..W11, W13 y W15..W20, cada una cerrada con el checklist "sin restos" y los estados del marcador pegados en el PR (cubre la parte previa de E0-FR-16). Ajustar README y notas segun el resultado del pin (Q13). Si W1 falla, cortar la contingencia v1.14.2 antes de seguir.
10. R20-11: merge a `main` sin tag -> `gh repo rename SnAgentsOS` -> `git remote set-url` sin token -> W0 (301 + "al dia" en 1.14.1) -> bump ya incluido -> `git tag v2.0.0 && git push origin v2.0.0` -> chequeo de 16 assets y de `releases/latest` -> W12 (update real de la instalada y la portable, los dos **sin restos**: sin `Programs\SnMultiCC` ni `%APPDATA%\snmulticc`, portable como `SnAgentsOS-portable.exe`, zip y marcador en `done`; cierra E0-FR-16 y E0-FR-20) -> recien entonces actualizar la instalacion propia del desarrollador -> actualizar las dos memorias de proyecto.
