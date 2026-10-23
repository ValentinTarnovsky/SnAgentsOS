# SnAgentsOS: mapa de capacidades

Una fila por capacidad: que hace, donde se ve, que archivos la implementan y que suite la verifica. Cada hito suma o actualiza sus filas en el mismo commit que la capacidad. Las filas van ordenadas por id.

- **id**: `area.capacidad` en camelCase (`status.failure`, `teams.integrate`). Unico; un id retirado no se reutiliza.
- **superficies**: desktop, celu, CLI, main (sin UI propia), dev o docs.
- **archivos**: los principales, no todos los que toca.
- **verify**: las suites que la prueban, como `scripts/<nombre>.cjs`, y entre parentesis el comando que las corre (`npm test`, `npm run test:ui`, `npm run test:mobile`).
- **desde**: version de la app en la que sale.

`scripts/test-docs.cjs` valida este archivo: a lo sumo 400 lineas, sin em dash ni en dash, una sola tabla sin lineas en blanco adentro, seis celdas por fila sin barras verticales adentro, ids unicos, cada suite de verify existe y `docs/snagentsos/README.md` lo enlaza.

## Capacidades

| id | capacidad | superficies | archivos | verify | desde |
|---|---|---|---|---|---|
| `core.deadlineTimer` | Trabajo de fondo en reposo: `set(key, at)` y `clear(key)` con un solo `setTimeout` al deadline mas cercano y reloj inyectable; sin deadlines no queda ningun timer | main | `src/main/DeadlineTimer.ts` | `scripts/test-deadlines.cjs` (npm test) | 2.7.0 |
| `dev.worktreeInstance` | Un worktree vinculado corre su instancia de dev con userData `snagentsos-dev-<sha8>` y un offset fijo (11 a 99) en los puertos default del celu, del Share y de los hooks, asi convive con la app instalada y con el dev del checkout principal, que sigue con `snagentsos-dev` y sin offset. `--user-data-dir` elige el perfil; el offset sigue al checkout | dev | `src/main/devUserData.ts`, `src/main/devPort.ts`, `src/main/pty/shellResolver.ts`, `src/main/index.ts` | `scripts/test-legacy-migration.cjs`, `scripts/test-rebrand.cjs` (npm test) | 2.7.0 |
| `docs.attribution` | Atribucion MIT de stablyai/orca y paperclipai/paperclip: encabezado `Adaptado de <proyecto> (MIT) - <ruta>` en la primera linea de cada archivo portado y una seccion por proyecto con su licencia completa en `THIRD_PARTY_NOTICES.md`, que viaja con la app | docs | `THIRD_PARTY_NOTICES.md`, `CLAUDE.md`, `docs/STYLEGUIDE.md`, `electron-builder.yml` | `scripts/test-docs.cjs` (npm test) | 2.7.0 |
| `docs.features` | Este mapa de capacidades, validado y enlazado desde el README de los documentos | docs | `docs/snagentsos/FEATURES.md`, `docs/snagentsos/README.md` | `scripts/test-docs.cjs` (npm test) | 2.7.0 |
| `labs.settings` | Ajustes > Labs con las funciones experimentales (`consoleChat`, `teams`), apagadas por defecto; un valor basura carga apagado. Las claves salen de `LABS_KEYS` | desktop | `src/shared/labs.ts`, `src/main/store/schema.ts`, `src/renderer/components/settings/sections/LabsSection.tsx`, `src/renderer/components/settings/searchCatalog.ts` | `scripts/test-labs.cjs`, `scripts/test-desktop-comfort.cjs` (npm test) | 2.7.0 |

## Checklist manual de punta a punta

Recorrido de Equipos en runtime, al cierre de la tanda B (se completa en B9). Se prueba como dice `CLAUDE.md` ("Probar en runtime"), en un repo temporal.

- [ ] Preparacion: `npm run build` y `node_modules/electron/dist/electron.exe out/main/index.js --user-data-dir=<temp>`, sin `ELECTRON_RENDERER_URL`, con otro puerto remoto, los hooks apagados, el cambio automatico de cuenta apagado y el `CLAUDE_CONFIG_DIR` y el `CODEX_HOME` reales, sin copiar `.credentials.json` ni `auth.json`.
- [ ] Ajustes > Labs: Equipos arranca apagado y se prende.
- [ ] Crear un equipo en el repo temporal y confiar en sus roles.
- [ ] Darle una meta al Lider: arma las tareas.
- [ ] Revisar el plan de una tarea y aprobarlo.
- [ ] Un Dev trabaja la tarea en su worktree.
- [ ] QA revisa la tarea.
- [ ] Dar el OK final.
- [ ] Integrar: queda un merge commit en main, con verify en verde, y el checkout del usuario limpio.
- [ ] Tomar el control de un miembro del equipo y Devolver.
- [ ] Celu: aprobar, contestar una pregunta, comentar una tarea y chatear con el Lider.
- [ ] La rutina diaria corre y el watchdog avisa.
- [ ] Cada fila de este archivo con su verify en verde.
