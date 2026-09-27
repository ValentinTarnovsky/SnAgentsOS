# Notificaciones y luces de estado: diagnostico y plan

Fecha: 2026-09-27. Base revisada: `f3e2a48`, SnMultiCC 1.13.0, config v9.
CLI locales: Codex 0.157.1 y Claude Code 2.1.283.
Estado: implementado para 1.14.0, config v10. El diagnostico y plan originales
se conservan abajo como referencia de la base 1.13.0.

## Resultado de implementacion

- Maquina de estados con proveedor, sesion, generacion PTY, solicitudes por ID,
  snapshot y estados de error/conexion perdida. Sin descarte de avisos por una
  ventana fija de 15 segundos.
- Claude: instalacion completa y reparable de 12 eventos. SessionStart usa un
  comando observador; los demas usan HTTP. Se respetan CLAUDE_CONFIG_DIR y los
  hooks ajenos. La configuracion personal no fue modificada durante las pruebas.
- Codex: integracion optativa con App Server stdio propio por consola y puente
  WebSocket privado. Cada terminal usa un token distinto. El launcher conserva
  entorno y directorio de la shell, incluidos cambios realizados antes de
  ejecutar codex. No usa el daemon compartido, cuyo framing difiere del API WS.
- Discord: cola acotada, menciones restringidas al ID configurado, reintentos
  HTTP transitorios, estado de entrega y prueba manual. URL excluida de exports.
- Luces en consolas y sidebar abierta/plegada, badges de solicitudes pendientes,
  visibilidad real al maximizar, reveal con enfoque, tooltips ajustados al viewport.

### Pruebas y limites comprobados

`npm test`: 89 verificaciones con protocolo simulado y transportes locales
reales, incluido SessionStart ejecutado por PowerShell, UTF-8, rechazo de tokens
incorrectos y Origin de navegador, configuracion e instalacion reversible en
directorios temporales. Discord se verifica con respuestas HTTP simuladas; no
se envio ningun mensaje a un webhook real.

Prueba manual de Codex 0.157.1 con el ejecutable Windows empaquetado y el runtime
dentro de app.asar: dos App Servers reales en el mismo directorio
producen sesiones distintas correctamente atribuidas. La TUI real iniciada desde
PowerShell mediante el launcher tambien informa su sesion. No se enviaron
turnos a modelos. Permisos/preguntas/errores y resume se prueban con eventos del
contrato generado por esa CLI, no con solicitudes facturadas a modelos.

`npm run test:ui` renderiza componentes reales en Electron con un perfil
temporal: luces y contador en ambas sidebar, nombres largos, temas claro/oscuro
y escala 100/125/150 por ciento. No reemplaza una validacion fisica de cada
escala de Windows. Los toasts nativos y el audio dependen de la configuracion
del sistema. La prueba nativa en esta maquina devuelve 0x803E0114 (Windows
bloquea este tipo de notificacion). La UI ahora muestra este bloqueo y ofrece
un boton de prueba de escritorio. No se cambiaron preferencias del sistema.
No se afirma entrega audible ni se probó un webhook real sin credenciales.
El significado de 0x803E0114 se verifico en el
[header oficial de Windows](https://github.com/microsoft/win32metadata/blob/main/generation/WinSDK/RecompiledIdlHeaders/shared/winerror.h).

Las preguntas asincronas de tipo agentMessage no tienen un evento individual de
respuesta en el contrato observado: se reconocen al aceptar el servidor el
siguiente input del usuario. Los RPC con ID se resuelven individualmente.
No se promete deteccion de login, confianza inicial, menus sin eventos o texto
libre. SSH/WSL, rutas absolutas, --remote y --no-daemon no usan el launcher local.
Activar Codex requiere reiniciar la consola. Claude requiere instalar/reparar
hooks y reiniciar la sesion para asegurar la nueva configuracion.

## Plan original aprobado (referencia historica)

## Objetivo

Detectar cuando Codex o Claude requieren intervencion, avisar por escritorio y
por un webhook configurable de Discord, y mantener luces consistentes en cada
consola y en la barra lateral. Incluir correcciones visuales pequenas.

Interpretacion de "cualquier accion": cada nueva solicitud de intervencion,
incluidas preguntas, aprobaciones y fallos que detienen el trabajo. No implica
un ping por cada comando que el agente ejecuta. El aviso de fin de turno debe
ser configurable por separado; el valor propuesto es activado.

## Evidencia local

La configuracion de la aplicacion instalada tiene `enabled`, `notifyDone` y
`notifyAction` activados, pero `hooksEnabled=false` y ningun token de hooks.
No se encontraron handlers de SnMultiCC en los hooks de Claude del usuario.
Esto explica la ausencia de estados precisos de Claude. Codex no tiene un
adaptador de estados en el producto actual.

Se leyeron `.claude/CHANGE-PLAN.md` y la memoria externa del proyecto. El plan
anterior corresponde al telefono y no se reanudo. La memoria de estados se
comprobo contra el codigo y las versiones actuales.

### Defectos confirmados

| Prioridad | Problema y efecto | Evidencia |
| --- | --- | --- |
| Alta | Codex no genera luces ni avisos: el detector solo entiende titulos y hooks de Claude. | `src/main/status/StatusManager.ts:51`, `src/main/status/HookInstaller.ts:16`; reproduccion |
| Alta | Dos solicitudes distintas en menos de 15 segundos: la segunda pierde el aviso definitivamente. | `StatusManager.ts:34`, `StatusManager.ts:272`; reproduccion |
| Alta | Maximizar A oculta B, pero B sigue en el conjunto visible. Sus avisos y badges se suprimen. | `src/renderer/lib/useStatusEvents.ts:54`, `src/renderer/lib/store.ts:588`, `src/renderer/components/layout/PaneCell.tsx:72` |
| Alta | Un titulo neutro inicia un temporizador que puede borrar un estado preciso recibido despues. | `StatusManager.ts:120`, `StatusManager.ts:175`; reproduccion |
| Alta | `sessionId` se recibe pero no se utiliza. Un `SessionEnd` antiguo puede borrar la nueva sesion de la consola. | `src/main/status/HookServer.ts:125`, `StatusManager.ts:214`; reproduccion |
| Media | En modo titulo, otro titulo detenido cambia `action` a `idle` sin respuesta del usuario. | `StatusManager.ts:170`; reproduccion |
| Media | `PermissionRequest` y `PreToolUse` no se procesan. Se depende de notificaciones tardias o del titulo para preguntas y permisos. | `StatusManager.ts:179`, `HookInstaller.ts:16`; reproduccion |
| Media | La barra lateral fuerza contador cero en el workspace activo, aunque haya consolas minimizadas pendientes. | `src/renderer/components/sidebar/Sidebar.tsx:160` |
| Media | El clic de una notificacion no desmaximiza la otra consola ni enfoca la consola destino. Puede reconocer un aviso sin mostrar su terminal. | `useStatusEvents.ts:30`; comparar `src/renderer/lib/focusWorkspace.ts` |
| Media | La suscripcion del renderer no pide un snapshot inicial de estados. Una recarga depende de que llegue otra transicion. | `useStatusEvents.ts:20`, `src/shared/ipc-contract.ts:345` |
| Media | La salud de hooks se decide por la primera URL encontrada; no verifica todos los eventos ni confirma recepcion. "Instalada" no significa operativa. | `HookInstaller.ts:83`, `HookInstaller.ts:112`, `src/renderer/components/settings/sections/NotificationsSection.tsx:161` |

La documentacion actual de Claude no admite HTTP para `SessionStart`, aunque
el instalador actual lo usa. Debe comprobarse con la CLI instalada y sustituirse
por un transporte compatible. [Referencia oficial](https://code.claude.com/docs/en/hooks#prompt-based-hooks).

### Reproduccion y alcance de la prueba

La caracterizacion inicial usaba `scripts/diagnose-status.cjs`, ahora sustituido
por las regresiones corregidas de `npm test`. Compilaba en memoria el
`StatusManager` actual y sustituye Electron y los temporizadores por dobles.
Confirma los seis casos marcados como reproduccion sin notificaciones reales,
sin escribir configuraciones personales y sin llamadas a modelos.

Es una caracterizacion de defectos: sus assertions esperan el comportamiento
actual defectuoso. Durante la implementacion deben convertirse en pruebas de
regresion que exijan el resultado corregido.

`npm run typecheck` pasa para main, renderer y mobile en la base revisada.
No equivale a probar las notificaciones nativas, Discord ni sesiones interactivas.

## Estados y datos que debe conservar el sistema

Separar actividad, solicitudes pendientes y salud de la integracion. Un agente
puede seguir trabajando mientras deja una pregunta asincrona para el usuario.

| Dato | Uso |
| --- | --- |
| `provider`, `paneId`, `ptyId` y generacion de lanzamiento | Atribuir el evento y descartar procesos anteriores |
| `sessionId` / `threadId`, `parentThreadId`, `turnId` | Separar sesiones, turnos y subagentes |
| `activity`: idle / working / done / error / unknown | Estado de ejecucion; unknown no debe parecer exito |
| `pendingRequests` por ID | Conservar varias preguntas o aprobaciones simultaneas |
| `reason`: permission / question / plan / elicitation / failure | Explicar que necesita el usuario |
| Fuente, precision y ultima recepcion | Distinguir estado preciso, titulo aproximado y conexion perdida |
| Estado del aviso por evento y canal | Deduplicar escritorio y Discord sin eliminar otra solicitud |
| Reconocimiento visual | Ver una consola no resuelve el permiso o la pregunta |

La fuente estructurada tiene prioridad sobre el titulo. Los titulos no borran
solicitudes pendientes. Los eventos viejos no modifican una nueva generacion.
Un `Stop` observado requiere reconciliacion: otro hook puede continuar el turno.
Un error de herramienta recuperable no se confunde con un agente detenido.

## Cobertura por proveedor

### Claude

| Situacion | Senal candidata |
| --- | --- |
| Inicio y fin de sesion | `SessionStart`, `SessionEnd` |
| Trabajando | `UserPromptSubmit`, progreso estructurado |
| Permiso | `PermissionRequest`; `Notification` como respaldo deduplicado |
| Pregunta o plan | `PreToolUse` de `AskUserQuestion` / `ExitPlanMode` |
| Dialogo MCP | `Elicitation`, respuesta con `ElicitationResult` |
| Solicitud resuelta | Resultado de herramienta correspondiente; considerar cancelacion |
| Fin de respuesta | `Stop`, reconciliado con continuacion posterior |
| Fallo terminal | `StopFailure` |

Validar estos contratos en 2.1.283. Usar handlers observadores que no devuelvan
decisiones de permisos. El titulo queda como respaldo identificado como
aproximado. [Hooks oficiales de Claude](https://code.claude.com/docs/en/hooks).

### Codex

El protocolo generado por **la CLI local 0.157.1** confirma:

- `ThreadStatus`: `notLoaded`, `idle`, `systemError`, `active`.
- `ThreadActiveFlag`: `waitingOnApproval`, `waitingOnUserInput`.
- Solicitudes: `item/commandExecution/requestApproval`,
  `item/fileChange/requestApproval`, `item/permissions/requestApproval`,
  `item/tool/requestUserInput`, `mcpServer/elicitation/request`.
- Resolucion: `serverRequest/resolved`. Revisar tambien `turn/completed`,
  errores terminales y desconexion para no conservar luces obsoletas.

Se genero con `codex app-server generate-ts --out <directorio-temporal>`.
No se modifico la configuracion de Codex ni se conecto un cliente a sesiones vivas.

Los hooks de Codex permiten observar permisos, herramientas y ciclo de vida;
requieren confianza explicita mediante `/hooks`. No hay que sobreescribir el
`notify` existente: en esta maquina pertenece a otra integracion.
[Hooks oficiales](https://learn.chatgpt.com/docs/hooks).

**Primera prueba de implementacion:** demostrar atribucion exacta consola-sesion
con dos Codex abiertos en el mismo directorio, incluyendo servidor compartido,
resume y preguntas asincronas. El directorio de trabajo no es un identificador.
La existencia de estos tipos no prueba por si sola que un segundo cliente reciba
todos los eventos de otro cliente. Evaluar hooks para atribucion y un observador
de App Server para reconciliacion sin tomar control ni responder solicitudes.
[App Server](https://learn.chatgpt.com/docs/app-server).

Si el modo compartido no permite esa observacion, evaluar un modo integrado por
consola con transporte compatible y alcance explicito. No reemplazar las
terminales existentes ni cambiar sus comandos silenciosamente. La cobertura de
preguntas asincronas queda pendiente de esta prueba, no se declara completa.

### Limites que deben mostrarse con honestidad

Login inicial, confianza de carpeta, menus propios del CLI, shells SSH/WSL y
preguntas escritas como texto libre pueden no emitir los mismos eventos.
Inventariarlos durante la prueba real. Un fin de respuesta configurable cubre
preguntas en texto libre, pero no permite clasificarlas con certeza.
La integracion local no debe presentarse como operativa para un CLI remoto sin
un canal demostrado. No se propone detectar estados por regex sobre texto PTY.

## Discord en Configuracion > Notificaciones

Proponer un bloque con activar/desactivar, URL oculta, ID de usuario a mencionar,
avisar por intervencion, avisar al terminar, y boton de prueba con resultado.
El canal Discord funciona independientemente del interruptor de escritorio y,
por defecto, tambien mientras SnMultiCC esta enfocado.

Mensaje: mencion al usuario, proveedor, workspace, consola, motivo y hora.
Omitir por defecto prompts, comandos, respuestas completas y contenido sensible.
Validar URL HTTPS de webhook Discord y enviar desde main. Restringir
`allowed_mentions` al usuario configurado. Usar `wait=true`, cola con limite,
timeout, reintento acotado para fallos transitorios y respeto de `retry_after`
en HTTP 429. Mostrar fallos permanentes y entrega incierta sin revelar el token.
No puede garantizarse entrega exactamente una vez tras un timeout ambiguo.
[Contrato oficial del webhook](https://docs.discord.com/developers/resources/webhook#execute-webhook).

Deduplicar por proveedor, sesion, turno e ID de solicitud. Dos solicitudes
distintas deben producir dos avisos aunque ocurran en menos de 15 segundos.
El envio HTTP nunca bloquea el hook ni la terminal. Una prueba remota solo se
ejecuta cuando el usuario configure y accione el boton, no al guardar cada tecla.

Config propuesta: `notifications.discord` con `enabled=false`, `webhookUrl=''`,
`userId=''`, `notifyAction=true`, `notifyDone=true`. Defaults a nivel de campo,
validacion IPC y migracion compatible de config v9 a v10. Mantener secretos
fuera de logs y snapshots del telefono; definir su tratamiento en exportaciones.

## Luces y ajustes pequenos de UI

- Reutilizar `StatusDot`: violeta trabajando, ambar intervencion pendiente,
  verde turno terminado, rojo fallo terminal y gris inactivo. Integracion
  ausente o desconectada debe tener texto propio, no verde.
- Mantener luz de consola y agregar luz agregada por workspace, visible con
  sidebar abierta y plegada. Prioridad propuesta: fallo / intervencion /
  trabajando / terminado / inactivo; tooltip con desglose por consola.
- Mantener contador de solicitudes pendientes, incluido el workspace activo.
  Una pregunta asincrona conserva ambar aunque el agente continue trabajando.
- Unificar calculo de visibilidad: workspace activo, ventana enfocada,
  minimizadas y maximizacion. Usarlo en main, badges y reconocimiento.
- El clic del aviso restaura ventana y consola, resuelve la maximizacion que la
  oculta y enfoca el terminal correcto.
- En la sidebar, el badge se oculta con hover y se reemplaza por el menu.
  Reservar espacio estable para ambos, evitando saltos y avisos ocultos.
- Revisar ancho del wrapper de `Tooltip` al plegar la sidebar: usa `inline-flex`
  y puede alterar el area clickeable. Confirmar geometricamente antes de editar.
- Ajustar tooltips largos: actualmente combinan `max-w-[260px]` y
  `whitespace-nowrap`, sin ajuste a los bordes del viewport. Probar nombres largos.
- Mostrar integracion desactivada, instalada sin eventos, operativa o con error.
  Cambiar textos globales de "Claude" a proveedor correspondiente.
- Incluir `Codex`, `Discord` y `webhook` en la busqueda de configuracion.

Se inspecciono la ventana instalada: Codex estaba trabajando sin luz de estado y
la sidebar no mostraba luces de agente. Los posibles recortes/alineaciones se
marcan para prueba visual; no se declaran defectos de pixeles demostrados.

## Orden de implementacion y archivos

1. Probar contratos y atribucion Codex/Claude. Resultado exigido: matriz de
   cobertura real, incluidas preguntas asincronas y dos sesiones en un directorio.
2. Corregir maquina de estados y eventos: `src/main/status/StatusManager.ts`,
   `HookServer.ts`, `HookInstaller.ts`; adaptador Codex acotado. Agregar snapshot
   inicial y salud en `registerStatusIpc.ts`, contratos, canales y preload.
3. Incorporar envio Discord en main, esquema/defaults/tipos y configuracion
   localizada. Comprobar importacion/exportacion y el snapshot remoto.
4. Corregir visibilidad, reconocimiento y enfoque en `useStatusEvents.ts` y
   `store.ts`; reutilizar `StatusDot.tsx` en `Sidebar.tsx`. Ajustes pequenos de
   Tooltip y layout solamente cuando la prueba visual los confirme.
5. Convertir reproducciones en regresiones, verificar integracion y construir.
   Actualizar documentacion de uso y limitaciones reales.

## Aceptacion

- Cada nueva aprobacion/pregunta produce su aviso; repetir el mismo evento no.
- Dos solicitudes en 15 segundos conservan ambos avisos. Varias solicitudes
  simultaneas no se resuelven al terminar solo una.
- Una pregunta asincrona mantiene atencion mientras sigue el trabajo.
- Ningun evento de otra sesion, subagente o PTY anterior borra el estado actual.
- Responder o cancelar actualiza el estado sin depender del spinner del titulo.
- Maximizar/minimizar, cambiar workspace y recargar renderer conservan estados
  correctos. Clic en aviso llega a la consola exacta.
- Discord funciona con escritorio desactivado y app enfocada. Probar 429, 5xx,
  timeout y URL invalida contra servidor simulado, sin publicar mensajes reales.
- Instalar/reparar/desinstalar conserva hooks ajenos y configuraciones UTF-8;
  verificar todos los handlers, no solo la primera URL.
- Typecheck completo y build escritorio+mobile. Prueba interactiva en perfil
  temporal sin cerrar la aplicacion del usuario.
- Revision visual en sidebar abierta/plegada, nombres largos, ventana minima,
  temas claro/oscuro y escalas Windows 100/125/150 por ciento.
- Toast y sonido se validan en Windows; TypeScript verde no prueba entrega.

No se ejecutaron envios a Discord, instalaciones de hooks, cambios de config
personal, modificaciones del producto, commits ni releases en esta preparacion.
