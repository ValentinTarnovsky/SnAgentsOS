# PRD SnAgentsOS

Fecha: 2026-10-17. Base: `main` `4c521f9` (SnMultiCC 1.14.1, `CONFIG_VERSION` 10, `PROTOCOL_VERSION` 1).
Estado: roadmap aprobado completo por el usuario (pasos mobile M1-M14, ideas desktop 1-19 y la lista "más adelante"). El rebrand sale primero y solo, como v2.0.0.
Fuentes: análisis de 12 áreas de `stablyai/orca` (MIT) contra SnMultiCC, síntesis aprobada y los PRD de cada épica (`epics/<id>.md`). Este documento es el marco común y no repite el detalle de las épicas.

## Vision

SnAgentsOS es un centro de mando con lógica de sistema operativo para correr y supervisar muchos agentes de código con IA (Claude Code y Codex) junto con terminales comunes, desde el escritorio y desde el celular.

La analogía con un sistema operativo guía el producto:
- **Procesos con estado.** Cada consola es un proceso con un estado visible (`working`, `action`, `done`, `error`, `idle`). Ese estado sale de señales exactas (hooks de Claude, App Server de Codex, OSC title) y nunca de leer la pantalla.
- **Notificaciones.** El sistema avisa quién te necesita, sin molestar por la consola que ya estás mirando, y en el bolsillo solo cuando no estás en la PC.
- **Continuidad.** Un update, un crash o un reinicio de Windows no hace perder el contexto: los chats se retoman, el scrollback vuelve y las consolas sobreviven a fallas de la UI.
- **Shell y automatización.** Una CLI (`snaos`) en cada consola, Quick Commands, configuración por repo (`.snagentsos.json`), automatizaciones recurrentes y una skill para que Claude maneje la app.
- **Periférico remoto.** El celular deja de ser un espejo de terminal y pasa a ser una segunda pantalla de trabajo: lista primero, respuestas de un tap, composer real, vista Chat y terminal del tamaño del teléfono.

Promesa del producto: **saber de un vistazo qué agente te necesita y responderle desde donde estés, sin perder nada en el camino.**

## Por que el cambio de nombre

- **El nombre describe lo que el producto fue, no lo que es.** "SnMultiCC" ("Multi Command Consoles", y "CC" se lee como Claude Code) describía un multiplexor de terminales. Hoy el producto supervisa agentes de dos proveedores, tiene cliente mobile, estado en vivo, notificaciones y, con este roadmap, CLI, automatizaciones y git. "SnAgentsOS" dice lo que hace: un entorno para operar agentes. Se conserva el prefijo de marca "Sn".
- **El roadmap crea piezas que llevan el nombre adentro.** La CLI (`snaos`), el archivo por repo (`.snagentsos.json`), la skill (`~/.claude/skills/snagentsos`), el prefijo de variables (`SNAOS_`), las claves de `localStorage` del celular y la entrada "Abrir en SnAgentsOS" del Explorador quedan en scripts del usuario, en repos y en `~/.claude`. Si nacen con el nombre viejo, después hay que migrarlas una por una y mantener alias para siempre.
- **El costo de migrar crece con cada release.** El nombre está atado a estado persistente: la carpeta `userData`, el appId, el GUID de NSIS, el AUMID de las notificaciones, los hooks de `~/.claude/settings.json`, el login item, las credenciales del celular y el repo de GitHub del que lee el updater. Hoy hay 117 líneas en 38 archivos y un solo usuario. Es el momento más barato.
- **Major propio.** El rebrand cambia identificadores que el sistema operativo trata como otra app (exe, appId, reglas de firewall, pin de la barra de tareas). Por eso es un major (v2.0.0) sin features nuevas: si algo falla, el diagnóstico es simple.
- **Migración automática y sin restos (decisión final del usuario).** "Quiero que sea todo automático, que al instalar el nuevo SnAgentsOS migre todo SnMultiCC y borre las cosas viejas." Al instalar o actualizar a v2.0.0, el instalador y la app migran todo y después borran solos los restos de SnMultiCC (carpeta de datos, carpeta de instalación, accesos directos, registro, temporales, cachés y hooks), sin botones de importar ni de limpiar. El borrado solo ocurre después de verificar la migración y confirmarla en el marcador (E0-FR-27, FR-29). **El rollback a 1.x no está soportado.** La única red de seguridad es `migration-backup-v1.zip` dentro de la carpeta de datos nueva, que se borra solo a los 30 días: es deliberada y no cuenta como "dejar lo viejo" (E0-FR-28).

Convenciones fijas desde v2.0.0 (fuente única: `src/shared/brand.ts`, E0-FR-01):

| Concepto | Valor |
|---|---|
| Producto | SnAgentsOS |
| Paquete npm | `snagentsos` |
| appId | `com.sndevelopment.snagentsos` |
| Repo | `ValentinTarnovsky/SnAgentsOS` |
| CLI | `snaos` |
| Config por repo | `.snagentsos.json` |
| Skill de Claude | `~/.claude/skills/snagentsos` |
| Prefijo de variables de entorno | `SNAOS_` |
| Prefijo de `localStorage` mobile | `snagentsos.` |
| Título del cliente mobile | SnAgentsOS Remote (no se traduce) |
| Datos portable | `<dir del .exe>/snagentsos-data` |
| `userData` en dev | `snagentsos-dev` |

## Usuario y contexto

- **Un solo usuario, power user.** Es el dueño, desarrollador y único usuario de la app. Conoce todas las features, así que no hacen falta onboarding, tips ni tours. Lee la UI en español (rioplatense) y la app mantiene inglés como segundo idioma.
- **Plataforma.** Windows 11 es la principal, con instalador NSIS y portable. macOS y Linux se compilan en CI y no se tienen que romper, pero no son el foco de las pruebas manuales. Shells: PowerShell 5.1, pwsh y SSH por Connection Profiles.
- **Agentes.** Claude Code (hooks HTTP más OSC title) y Codex (App Server por consola con puente WebSocket). Corre entre 4 y 12 sesiones en paralelo, repartidas en varios workspaces.
- **Trabajo real.** Repos de plugins de Minecraft (Java/Maven sobre SnLib, con release por GitHub) y el repo de esta misma app (Electron, React, TypeScript). Muchas tareas largas de agentes que piden permisos o preguntan en momentos impredecibles.
- **Celular.** Navegador del teléfono contra el RemoteServer embebido, por LAN o Tailscale, emparejado con HMAC y aprobación en el desktop. Lo usa desde el sillón, en otra habitación o fuera de casa por Tailscale, a menudo con la pantalla bloqueada entre consulta y consulta. Funciona en Android y en iOS; `navigator.vibrate` y el push sin PWA instalada solo andan en Android.
- **Restricciones que elige el usuario.** Nada de tienda de apps, nada de nube paga, nada de servicios de terceros obligatorios. GitHub (con `gh`) es la única infraestructura externa, para código y releases.

## Objetivos y metricas de exito

| # | Objetivo | Hoy (1.14.1) | Meta | Release | Cómo se mide |
|---|---|---|---|---|---|
| O1 | Rebrand automático: todo migrado y nada viejo | n/a | 100% de workspaces, presets, ajustes, Quick Buttons, conexiones, uso y celulares migrados y verificados (hash por archivo, config efectiva idéntica, mismos conteos). Después de la limpieza: 0 restos legados del inventario L01-L21 de E0 (salvo las excepciones documentadas L19 y L21 y los `skipped: needsElevation` con acción en el aviso), `migration-backup-v1.zip` presente y válido en `dataDir()` hasta su vencimiento a los 30 días. 0 celulares re-emparejados, 0 hooks huérfanos, 0 pasos manuales desde 1.14.x (excepciones abajo) | v2.0.0 | `test-rebrand.cjs` (hash de la fuente, lista blanca exacta, inventario con fallas inyectadas) y pruebas manuales W1, W3, W12 y W18-W20 de E0 (sin restos al final de cada una) |
| O2 | Sin restos del nombre viejo | 117 líneas en 38 archivos | 0 ocurrencias fuera de la allowlist | v2.0.0 | `check-brand.cjs` en `npm test` |
| O3 | Release nunca visible incompleto | unos 2.5 min por release con `latest` incompleto | 0 s. `latest` cambia solo con 16 assets y sus `.sha256` | v2.0.0 | job `release-notes` y prueba W14 |
| O4 | Cambiar de consola en el celular | 3 taps (grilla, scroll, elegir) | 1 tap (tira de tabs) | v2.1 | conteo en prueba manual |
| O5 | Saber qué consola espera, desde el celular | abrir las consolas de a una | 0 taps: estado visible en tabs, pill y lista | v2.1 (Home v2.2) | prueba manual |
| O6 | Latencia del estado desktop -> celular, con la página abierta | no se transmite | p95 <= 1 s desde la transición a `action` | v2.1 | timestamps del evento y de la recepción en un test de integración |
| O7 | Enterarse de un agente esperando con el celular bloqueado y lejos de la PC | solo Discord, si está configurado | aviso ntfy en p95 <= 15 s, y ninguno mientras el usuario está activo en la PC | v2.2 | log de entrega del notificador |
| O8 | Responder un permiso o una pregunta desde el celular | buscar el dígito en un menú TUI de 8 px | 1 tap por permiso y 1 tap por opción en AskUserQuestion | v2.2 | prueba manual con hooks reales |
| O9 | Reconexión al volver a la app o desbloquear | depende del timer; un socket zombie no se detecta | p95 <= 3 s con red disponible. Zombie detectado en <= 28 s (20 s de silencio más 8 s de deadline) | v2.1 | test del cliente con reloj simulado y prueba W5 |
| O10 | Contexto de los agentes después de update, reinicio o crash | se pierde todo | 100% de las consolas Claude/Codex con `sessionId` conocido ofrecen retomar (salvo SSH) | v2.1 | test del registro de sesiones y prueba manual de update |
| O11 | Consolas que sobreviven a una falla de la UI | todas mueren (el unmount mata el pty) | 0 consolas muertas por un crash del renderer o de un pane | v2.2 | inyección de errores en un test de UI |
| O12 | Scrollback después de reiniciar | 0 líneas | hasta 2000 líneas por consola (configurable hasta 5000) | v2.2 | test de persistencia |
| O13 | Legibilidad del terminal en el celular | letra de 8 px y paneo horizontal en panes anchos | modo celular: el PTY toma la grilla del teléfono, sin paneo horizontal | v3.0 | prueba manual |
| O14 | Automatizar sin abrir la UI | no existe | toda acción básica (`ls`, `open`, `spawn`, `send`, `read`, `wait --idle`, `status`, `notify`) disponible por `snaos --json` | v3.0 | suite de la CLI |

Métrica guardiana durante todo el programa: **cero regresiones** en el fix de mojibake (renderer Canvas por defecto), en las luces de estado de 1.14 y en el emparejamiento del celular.

Métricas guardianas de la migración de v2.0.0 (E0):
- **0 borrados automáticos sin `committed`.** Ningún artefacto legado se borra si el marcador no llegó a `phase: 'committed'` después de verificar (FR-27) y de escribir y verificar el zip (FR-28).
- **0 re-migraciones después de `committed`.** Si la carpeta vieja cambia después del commit, los datos de 2.x ganan y los cambios van al zip como `post-commit/` (FR-30).
- **Excepciones explícitas a "cero pasos manuales"**, todas avisadas en el modal de FR-10 y nunca con un prompt de UAC lanzado por la app: volver a fijar el ícono en la barra de tareas si el desinstalador viejo lo desfijó (FR-31); desinstalar a mano una 1.x per-machine cuando 2.x se instaló "solo para mí" (FR-32); mover `SnMultiCC.app` a la Papelera si macOS no da permisos (FR-36); el `.deb` de Linux, que exige root (L21); y el instalador que se detiene si hay datos de una portable dentro de la carpeta de instalación vieja (FR-15). Si una 1.x está abierta al migrar, aparece el único diálogo del flujo, que la cierra (FR-09).

## No objetivos

Condensado de la síntesis ("Lo que NO copiar"), con el motivo:

- **App nativa (Expo/React Native, shell nativo con bundle OTA).** Exige tienda de apps y todo se puede hacer con React DOM y CSS en el cliente web actual.
- **Infraestructura en la nube (relay, push gateway APNs/FCM).** Es infraestructura paga para un solo usuario. Tailscale ya resuelve el acceso fuera de la LAN y ntfy (más adelante Web Push) cubre los avisos.
- **Cifrado E2EE de frames sobre LAN.** El bundle llega por http, así que no protege contra un MITM. El modo HTTPS por Tailscale (M14) es el camino correcto.
- **Daemon de PTYs separado.** Esfuerzo XL y, en Windows, bloquea los archivos durante el update. Retomar chats, el snapshot headless y el scrollback persistido cubren la mayor parte del problema.
- **xterm 6 o WebGL por defecto.** xterm 6 elimina `addon-canvas`, que es el fix fijo del mojibake.
- **Varios hosts en un mismo cliente, o handoff de credenciales entre orígenes.** Cada desktop es su propio origen con su propio `localStorage`. El costo de seguridad no compensa: la IP 100.x de Tailscale ya es estable.
- **Varias cuentas de Claude/Codex con "mover sesiones".** Es L y no hay evidencia de que haga falta.
- **Onboarding, tips y feature walls.** El único usuario ya conoce todo.
- **Detección de estado o permisos por regex sobre la salida, y sesiones estructuradas (ACP).** Chocan con la idea de TUIs reales. Los hooks ya dan señales exactas.
- **Decidir permisos dejando abierto el hook PermissionRequest.** Rompe el contrato de respuesta vacía con timeout de 3 s y deja a Claude colgado si el celular se desconecta. Mandar "1" o Esc al PTY es más seguro.
- **STT local o dictado por el desktop.** Alcanza el micrófono del teclado del celular dentro del composer. Enmienda app 2.2.0 ([E9](epics/E9.md)): el celu suma un botón de dictado con el reconocimiento del navegador (solo HTTPS); el desktop sigue sin dictado.
- **Superficie de IDE o de forge (PR pages, Jira/Linear/GitLab, commit/push desde la UI, Monaco, diff combinado, browser embebido, orquestación DAG).** Queda fuera del alcance de un centro de mando personal. Git se limita a lectura, revisión y worktrees. Enmienda app 2.2.0 ([E9](epics/E9.md)): entra un panel Archivos con un editor liviano (CodeMirror 6, sin LSP ni búsqueda global) para leer y corregir lo que tocan los agentes.
- **Auto-merge y títulos generados por LLM.** Son riesgosos o innecesarios. Se abre el diff o se hace checkout de la rama, y el título sale del topic del OSC title.
- **Coalescer de escritura en el cliente y librería de componentes.** El server ya agrupa a 16 ms, y los tokens de Tailwind alcanzan.

## Principios de diseno

1. **Status-first.** Lo primero que se ve, en desktop y en celular, es el estado de cada agente y quién te necesita. El terminal es el detalle, no la portada.
2. **List-first en mobile.** El celular abre en una lista (Home). El terminal es una pantalla apilada encima y "atrás" siempre vuelve al panorama general.
3. **El color es solo para estados.** UI monocromática con un único botón primario por pantalla. Ámbar, rojo, verde y violeta significan estado, nunca decoración. Los tokens viven en `docs/STYLEGUIDE.md` (owner E4) y valen para desktop y mobile. El color nunca es la única señal: siempre va con glifo, texto o `aria-label`.
4. **Hooks antes que screen scraping.** El estado, los permisos, las preguntas y el preview salen de hooks, del App Server de Codex, del OSC title o del transcript JSONL. Nunca de regex sobre la salida del PTY.
5. **Sin tienda de apps.** El celular usa el cliente web que sirve el desktop, instalable como PWA. Nada requiere publicar en App Store ni en Play Store.
6. **Local-first, sin nube paga.** Todo corre en la PC del usuario. El acceso remoto va por LAN o Tailscale. Los servicios externos son opt-in, gratuitos y reemplazables (ntfy, Discord), y sus secretos no salen en los exports.
7. **Main es autoritativo.** El proceso main es dueño del estado de los agentes, de los procesos y de los archivos persistentes. El renderer y el celular reflejan. Ningún canal acepta rutas desde el renderer o el celular sin validarlas en main.
8. **Cambios aditivos en los contratos.** `PROTOCOL_VERSION` sigue en 1 y todo campo o mensaje WS nuevo es opcional. `CONFIG_VERSION` sube una sola vez por release, con defaults de zod por campo. Los contratos que comparten varias épicas se definen una sola vez ("Contratos compartidos") y cada uno tiene un único owner.
9. **Cada paso se puede publicar por separado.** Cada paso M o idea entra a una release cuando está terminado, sin bloquear al resto. Las features nuevas que no tienen un camino seguro arrancan apagadas o con kill switch.
10. **Atribución MIT.** Reusar ideas, patrones y constantes de Orca no requiere atribución. Todo archivo que porte o adapte código lleva el header `// Adaptado de stablyai/orca (MIT) - <ruta original>` y el texto MIT completo va en `THIRD_PARTY_NOTICES.md`, que crea la primera épica que adapte código. No se usa el nombre, la marca ni los assets de Orca.

## Requisitos no funcionales globales

Valen para todas las épicas. Cada épica los puede endurecer, nunca relajar.

**Seguridad del servidor LAN y de los servidores locales**
- Se mantienen los invariantes actuales del RemoteServer: Host igual a una IP literal privada o de tailnet en el puerto configurado (anti DNS rebinding), Origin exactamente igual a `http://<Host>` en el upgrade WS (anti CSWSH), archivos estáticos confinados a la raíz del bundle, CSP estricta, `nosniff` y ninguna versión del server en las respuestas.
- La superficie sin autenticar sigue siendo solo el bundle estático y el upgrade `/ws`. Todo endpoint HTTP nuevo (por ejemplo la subida de imágenes de M10) es una excepción documentada: autenticado por device con la misma credencial HMAC, con las mismas validaciones de Host y Origin, límite de tamaño, allowlist de tipos y almacenamiento bajo `dataDir()`.
- Se mantienen el emparejamiento HMAC con aprobación en el desktop, el rate limiter por IP, la revocación con cierre 4403, `maxPayload` de 64 KB y la validación zod de todo mensaje del cliente (regla de 3 strikes). No se agrega ningún mensaje C->S sin su schema.
- Al celular no viajan `sessionId`, `cwd` ni rutas absolutas que no hagan falta. `openPath` y cualquier acción sobre archivos se validan en main.
- El HookServer y el servidor de la CLI escuchan solo en loopback o named pipe, con token por consola (y token maestro para la CLI). Nunca se exponen en la LAN.
- Los logs y los reportes de diagnóstico redactan `secret`, `hmac`, `proof`, `nonce`, tokens y `#pair=`. Los secretos de terceros (webhook de Discord, topic de ntfy) se excluyen de los exports.
- El updater mantiene la allowlist de hosts y `SAFE_ASSET_NAME` y, desde 2.x, exige el SHA-256 de cada asset.
- Ninguna escritura sobre `~/.claude` fuera de los hooks y la skill propios, y siempre con backup y sin pisar un JSON corrupto. Excepción única de v2.0.0: después de respaldarlo en `migration-backup-v1.zip`, se borra `settings.json.snmulticc.bak` (ruta exacta, E0-FR-13).

**Migración y limpieza del legado (v2.0.0, E0)**
- Verificar antes de borrar: nada legado se borra sin la fase `committed` en el marcador, y `committed` exige la verificación (hashes, zod, config efectiva igual, conteos) y el zip verificado.
- Si la verificación falla, no se borra nada: log, aviso no bloqueante y reintento en el próximo inicio.
- Idempotente y reanudable: un corte en cualquier fase, también a mitad de la limpieza, lo continúa el próximo arranque. Las carpetas con datos se borran en dos pasos (rename a tombstone y después borrado) para no quedar nunca a medio borrar con su nombre original.
- Guardas de ruta: lista blanca calculada en main, sin seguir symlinks ni junctions, y nunca sobre `dataDir()`, `userData` ni la carpeta del exe en ejecución.
- Una 1.x abierta se detecta (proceso o lock de instancia única) y se cierra o se espera antes de tocar su carpeta. Archivos bloqueados: reintentos y después `deferred` para el próximo inicio.
- Sin elevación: lo que exige admin queda `skipped: needsElevation` con una acción en el aviso. Las reglas de firewall viejas no se borran (quedan inertes).
- Sin rollback a 1.x. La red de seguridad es un único `migration-backup-v1.zip` en `dataDir()`, que se borra solo a los 30 días.

**Rendimiento (presupuestos)**
- Arranque en frío de la versión empaquetada: no más de 10% por encima de 1.14.1 en la misma PC. La migración del rebrand corre una sola vez: su parte sincrónica (migrar, verificar, zip y marcar) tarda menos de 800 ms en SSD y el arranque con migración tarda menos de 1 s más que sin ella. La limpieza del legado corre en segundo plano, arranca 3 s después de `ready-to-show` y no bloquea main más de 50 ms seguidos (E0).
- Ningún trabajo síncrono de más de 50 ms en el event loop de main por evento (estado, hooks, PTY). Las lecturas de transcript y de git son asíncronas y acotadas.
- Estado al celular: coalesce de 100 ms por pane, salvo las transiciones a `action`, `done`, `error` o `null`, que salen de inmediato. El flush de salida del PTY se mantiene en 16 ms.
- El emulador headless y el scrollback persistido se miden antes de activarse por defecto, y tienen modo `lazy` y kill switch `off`.
- Celular: la KeyBar y el composer responden al toque sin demora perceptible (objetivo: menos de 100 ms hasta el envío del frame). Las animaciones duran 300 ms o menos y respetan `prefers-reduced-motion`.
- Las escrituras a disco usan `tmp` más `rename` (atómicas) y no bloquean el cierre más allá de los timeouts definidos por cada épica.

**Windows, instalador y portable**
- Windows 11 es la plataforma de referencia de las pruebas manuales. Instalador NSIS por usuario y portable tienen paridad funcional, salvo el login item, que no existe en la portable.
- La portable es autocontenida: todo archivo persistente nuevo vive bajo `dataDir()` = `dirname(getConfigPath())`, nunca bajo `app.getPath('userData')` directo.
- Sin permisos de administrador. La única elevación es opt-in y explícita (arreglo de firewall vía UAC, M9). La app escribe el registro solo en HKCU; lee HKLM solo para detectar una 1.x per-machine durante la limpieza de v2.0.0. El instalador escribe en `SHCTX` (HKLM solo en una instalación per-machine, que ya pedía UAC en 1.x).
- Instalación en `Programs\SnAgentsOS` desde v2.0.0, también al actualizar desde 1.14.x (mismo GUID NSIS). El instalador desinstala la 1.x y su carpeta `Programs\SnMultiCC`; con `/S` sobre una 1.x per-machine la app queda en la carpeta vieja (limitación documentada en E0, R14).
- Rutas comparadas sin distinguir mayúsculas en Windows. Reintentos ante `EBUSY` y `EPERM` (antivirus). Todo archivo de texto se escribe en UTF-8 sin BOM.
- macOS y Linux: la CI compila los 16 assets y corre `npm test` en los 3 sistemas, y ninguna feature rompe esos builds. Las features solo para Windows (Explorador, firewall, AUMID) se degradan sin error en el resto.

**i18n**
- Toda cadena nueva existe en `es` (rioplatense, voseo, como los diccionarios actuales) y en `en`, en los tres diccionarios: main (`src/main/i18n.ts`), renderer y mobile.
- El nombre del producto se interpola (`{app}`, `{legacy}`) desde `brand.ts` y nunca se escribe literal en las cadenas. "SnAgentsOS Remote" es el nombre fijo del cliente y no se traduce.
- Formatos de tiempo relativo y números consistentes entre desktop y celular.

**Accesibilidad**
- Targets táctiles de al menos 44x44 px en el celular (filas de lista de 48 px).
- Todo indicador de estado lleva `role="img"` y `aria-label` localizado. Los contadores que cambian solos usan `aria-live="polite"`.
- Modales con `role="dialog"`, `aria-labelledby`, foco inicial definido, foco atrapado y Esc para cerrar. Los diálogos nativos definen `defaultId` y `cancelId`.
- Todo el desktop se puede usar con teclado, y los atajos se pueden reasignar y se muestran en la UI.
- Contraste AA en temas claro y oscuro. Con `prefers-reduced-motion`, sin animaciones ni spinners que giren.

**Estilo de texto**
- Ningún carácter em dash (U+2014) ni en dash (U+2013) en cadenas de UI, código, comentarios, docs, notas de release ni commits. Se usa "-".
- La guarda automática de marca (`check-brand.cjs`, E0-FR-23) se extiende para fallar también ante esos dos caracteres en los archivos trackeados de texto.

**Compatibilidad, versionado y pruebas**
- `CONFIG_VERSION`: 10 en v2.0.0, 11 en v2.1, 12 en v2.2 y 13 en v3.0. Un solo bump por release, coordinado en "Contratos compartidos", con migraciones idempotentes y defaults por campo.
- El celular tolera mensajes y campos desconocidos. Si cambia la versión del desktop, muestra la pantalla "Se actualizo SnAgentsOS en la PC - Recargar" (M2).
- Cada épica agrega pruebas automatizadas en el estilo de `scripts/test-status.cjs` (esbuild más `vm`, temporales en `os.tmpdir()`) y todas corren en `npm test`.
- Releases en draft hasta tener los 16 assets con sus `.sha256`, con notas versionadas en `docs/release-notes/<tag>.md`.

## Mapa de epics

| ID | Título | Releases | Resumen | Detalle |
|---|---|---|---|---|
| E0 | Rebrand a SnAgentsOS | v2.0.0 | Constantes de marca únicas, empaquetado y CI con el nombre nuevo, migración automática, verificada e idempotente de datos, hooks, login item y credenciales del celular, limpieza automática de todo resto de SnMultiCC después del commit (respaldo zip de 30 días, sin rollback a 1.x), upgrade desde 1.14.x con el GUID NSIS legado hacia `Programs\SnAgentsOS` desinstalando la 1.x, portable renombrada a `SnAgentsOS-portable.exe`, releases atómicos en draft y guarda `check-brand`. Sin features nuevas. | [epics/E0.md](epics/E0.md) |
| E1 | Mobile fundaciones (M1-M5) | v2.1 | El celular sabe quién te necesita (estado por pane, preview, pill "N esperando", aviso con la página abierta), conexión confiable (watchdog, triggers de reanudación, banner por niveles, pantalla "Actualizado"), KeyBar 2.0 parte 1, composer acoplado, tira de tabs, `Sheet`, `ActionList`, `useBackClaim` y `PushScreen`. | [epics/E1.md](epics/E1.md) |
| E2 | Mobile Home, respuestas y notificaciones (M6-M9) | v2.2 | Home con lista primero y terminal apilada, tarjetas de permiso y wizard de AskUserQuestion desde `pending[]`, selección y copia, scroll con momentum, diagnóstico con chequeo de firewall, ntfy, "Solo cuando no estoy en la PC", deep links y KeyBar parte 2. | [epics/E2.md](epics/E2.md) |
| E3 | Mobile como herramienta de trabajo (M10-M14) | v3.0 (M14 en v3.0 o después) | Foto o captura del celular al agente por POST autenticado, modo celular (phone-fit) con control de tamaño del PTY, vista Chat de Claude desde el transcript, historial de sesiones con retomar y modo HTTPS por Tailscale (Web Push, clipboard, Wake Lock). | [epics/E3.md](epics/E3.md) |
| E4 | Desktop comodidad diaria (ideas 1-5) | v2.1, v2.2 | Pila de toasts, pulido de UI (búsqueda en Ajustes, chips de atajo, tooltips con `stateSince`), `STYLEGUIDE.md` y `CLAUDE.md` del proyecto, y enriquecimiento de estado (`stateSince`, `lastMessage`, `activity`, `pending`) en v2.1. Tarjeta de update con chip, resiliencia ante crashes y "Abrir en SnAgentsOS" desde el Explorador en v2.2. | [epics/E4.md](epics/E4.md) |
| E5 | Agentes (ideas 6-9 y "más adelante") | v2.1, v2.2, v3.0 | Retomar conversaciones de Claude y Codex, paleta "Te esperan" y atajo a la siguiente, filas por agente en el sidebar con "qué está haciendo" y PC despierta mientras trabajan. Después, modal "Retomar chats interrumpidos", hibernación opt-in, tablero de agentes y timer del cache de prompts. | [epics/E5.md](epics/E5.md) |
| E6 | Motor de terminal (ideas 10-12) | v2.1, v2.2, v3.1+ | `ModeTracker`, Unicode11, tarjeta de salida real del shell, chip "Claude terminó" y fix de `defaultShell` en v2.1. Snapshot headless en lugar del ring de 256 KB y scrollback persistido en v2.2. Shell integration de PowerShell (OSC 133) sin agendar, v3.1 o después. | [epics/E6.md](epics/E6.md) |
| E7 | Git (ideas 13-16) | v2.1, v2.2, v3.0 | Imagen soltada en un pane como adjunto (v2.1). Chip de git por workspace y panel Changes de solo lectura, también en el snapshot mobile (v2.2). Notas de revisión sobre el diff enviadas al agente, pantalla Changes en el celular y worktree aislado por consola, base de la "carrera" por etapas sin auto-merge (v3.0). | [epics/E7.md](epics/E7.md) |
| E8 | Automatización y CLI (ideas 17-19 y "más adelante") | v2.2, v3.0, v3.1+ | Quick Commands en lugar de los Snippets y entrega de prompts compartida (v2.2). CLI `snaos`, skill `snagentsos`, `.snagentsos.json` con confianza por sha256, automatizaciones recurrentes, montaje parcial de workspaces, composer de workspace y nota por workspace (v3.0). Piezas mobile pendientes de contrato en v3.1+. | [epics/E8.md](epics/E8.md) |

Contenido por release:

| Release | Lema | Épicas |
|---|---|---|
| v2.0.0 | "Mismo producto, nombre definitivo" | E0 solo |
| v2.1 | "El celu sabe quién te necesita" | E1 completo y las partes v2.1 de E4, E5, E6 y E7 |
| v2.2 | "Home y respuestas con un tap" | E2 completo y las partes v2.2 de E4, E5, E6, E7 y E8 |
| v3.0 | "El celu como herramienta de trabajo" | E3 y las partes v3.0 de E5, E7 y E8 |
| v3.1+ | Sin agendar | shell integration de PowerShell (E6), piezas mobile de E8 sujetas a contrato |

Reglas del mapa:
- E0 no depende de nadie y todas las épicas dependen de E0-FR-01 (`brand.ts`) y de `dataDir()`.
- Cada contrato compartido tiene un único owner: el enriquecimiento de estado es de E4 (E1 lo transporta y E2 lo consume), el builder de argv para retomar (`buildAgentArgv`) es de E5 (E1 y E2 ponen la UI), la entrega de prompts es de E8 y los tokens de color son de E4.
- **Corrección pendiente de consistencia:** el borrador de E2 cita "E5, idea 13" (chip de git) y "E5, idea 17" (Quick Commands). Según este mapa, la idea 13 es de E7 y la idea 17 de E8. Hay que corregir esas referencias en E2 antes de cerrar el PRD.

## Glosario

- **Agente:** proceso de Claude Code o Codex que corre en una consola.
- **Consola / pane:** terminal individual dentro de un workspace, respaldada por un PTY (node-pty).
- **Workspace:** grupo de consolas con su grilla. Se monta de forma lazy la primera vez que se activa.
- **Preset:** plantilla para lanzar una consola (tipo, comando, env, ícono).
- **Connection Profile:** perfil SSH con pasos expect/send para abrir consolas remotas.
- **Estado del agente:** `working` (trabajando), `action` (te necesita: permiso, pregunta o plan), `done` (terminó), `error`, `idle` (inactivo) y `unknown`. Lo calcula `StatusManager` en main.
- **Hooks de Claude:** handlers HTTP y de comando que SnAgentsOS instala en `~/.claude/settings.json` y que reportan eventos al `HookServer` local (`/cc-hook/`).
- **OSC title:** secuencia de escape con la que Claude publica el título y el topic de la sesión. Se usa como señal de estado y como título sin LLM.
- **CodexBridge / App Server:** integración de Codex por consola con un puente WebSocket privado y un launcher `codex.cmd`.
- **`pending[]`:** lista de pedidos abiertos de un pane (permiso, pregunta) con sus datos, que produce E4 y consume E2.
- **RemoteServer:** servidor HTTP y WS embebido en el desktop que sirve el cliente mobile por LAN o Tailscale.
- **Device / emparejamiento:** celular registrado en `remote-devices.json` con credenciales HMAC después de que el usuario aprueba el QR en el desktop. Revocarlo cierra su socket con 4403.
- **Snapshot / `authOk` / `state`:** estado completo de workspaces y panes que el server manda al conectar y ante cada cambio.
- **`paneStatus`:** mensaje WS aditivo con el estado de un pane, enviado directo desde main.
- **`PROTOCOL_VERSION`:** versión del protocolo WS. Se queda en 1: todo cambio es aditivo.
- **`CONFIG_VERSION`:** versión del schema de `config.json`. Sube una vez por release.
- **Contratos compartidos:** sección donde se definen una sola vez los tipos, campos WS y claves de config que usan varias épicas.
- **`dataDir()`:** carpeta de datos actual, `dirname(getConfigPath())`. En la instalada es `%APPDATA%\snagentsos` y en la portable `<dir del .exe>\snagentsos-data`.
- **Legado / restos legados:** todo lo que dejó SnMultiCC 1.x en la PC (carpetas de datos e instalación, accesos directos, pin, registro, temporales, hooks, claves `snmulticc.remote.*` del celular). E0 los enumera como inventario L01-L21 y v2.0.0 los borra solos después del commit, salvo excepciones documentadas.
- **Marcador de migración:** `legacy-migration.json` (v2) en `dataDir()`, con copia en `legacy-migration.prev.json`. Guarda la fase de la máquina de estados (`migrating -> verified -> backedUp -> committed -> cleaning -> done`, más `failed`), el `outcome`, las fuentes con sus hashes, el respaldo y el estado de limpieza de cada ítem L. Solo `committed` habilita borrar algo legado.
- **Respaldo de migración:** `migration-backup-v1.zip` en `dataDir()`, con los archivos legados tal como estaban y un `manifest.json` con sus SHA-256. Única red de seguridad (no hay rollback a 1.x) y se borra solo a los 30 días.
- **Limpieza automática:** pasada en segundo plano, después de `committed`, que borra los restos legados con guardas de ruta, tombstones para las carpetas con datos y reintentos (`deferred`) para lo que está en uso.
- **AUMID:** Application User Model ID de Windows. Identifica a la app en las notificaciones y los accesos directos.
- **KeyBar:** barra de teclas especiales del cliente mobile.
- **Composer:** campo de texto real acoplado en el celular para escribir prompts, con borrador por pane. Se alterna con el modo **Directo**, que escribe al PTY tecla por tecla.
- **Home:** pantalla principal del celular desde v2.2: lista de workspaces y consolas con estado.
- **Phone-fit / modo celular:** el celular toma el control del tamaño del PTY para mostrarlo a su propia grilla. El desktop muestra "Tu celular controla esta consola [Recuperar]".
- **Vista Chat:** vista del celular que arma la conversación de Claude desde el transcript JSONL en lugar del terminal.
- **Snapshot headless:** emulador `@xterm/headless` en main que serializa el estado real del terminal para el reattach y el replay mobile.
- **Retomar:** relanzar un agente con su `sessionId` previo para continuar la conversación.
- **Quick Commands:** comandos guardados (global o por workspace) que envían texto a una consola o lanzan un agente con un prompt. Reemplazan a los Snippets.
- **`snaos`:** CLI de SnAgentsOS disponible en cada consola, con salida `--json`.
- **`.snagentsos.json`:** archivo por repo con grilla, consolas, setup y quick commands. Se ejecuta solo después de confiar en su sha256.
- **Skill `snagentsos`:** skill opt-in en `~/.claude/skills/snagentsos` que enseña a Claude a usar `snaos`.
- **ntfy:** servicio de notificaciones push por topic, usado como canal opt-in junto a Discord.
- **Tailscale:** red privada (tailnet, IPs 100.x) que da acceso al desktop fuera de la LAN sin exponer puertos.
- **Worktree por consola:** checkout aislado (`git worktree`) en una rama `sn/<slug>` para que cada agente trabaje sin pisar a los demás.
