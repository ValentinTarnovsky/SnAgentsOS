# Guia de estilo de UI

Reglas de UI y de copy para el desktop (`src/renderer`) y el cliente mobile (`src/mobile`). Es corta a proposito: ante la duda, copiar el componente vecino que ya cumple. Owner: E4. Las reglas de arquitectura viven en `CLAUDE.md`.

## 1. Feedback por duracion

| Duracion esperada | Que se muestra |
|---|---|
| 0 a 100 ms | Nada. Un spinner que parpadea es peor que ninguno |
| Hasta 1 s | El boton queda deshabilitado (`disabled`) mientras corre |
| 1 a 3 s | Spinner (`Loader2` con `animate-spin`) o cambio de label ("Guardando..."), con el ancho del boton reservado para que no salte |
| Mas de 3 s | Etiqueta por etapa ("Descargando 40%", "Verificando", "Instalando"), nunca un spinner mudo |

## 2. Que primitivo usar

| Queres... | Usa | No uses |
|---|---|---|
| Confirmar algo transitorio ("Copiado", "Enviado a 3 consolas") | Toast (pila de `src/renderer/lib/toast.ts`; en mobile `setToast` del store) | Modal, banner |
| Mostrar un estado que sigue vigente ("Puerto ocupado") | Error inline junto al control | Toast (se va solo) |
| Pedir una decision que bloquea ("Cerrar 3 consolas en ejecucion?") | Modal (`common/Modal.tsx`, `ui/ConfirmDialog.tsx`) | Popover, toast |
| Nombrar un boton de solo icono | `ui/Tooltip.tsx` | `title=""` nativo |
| Acciones por clic derecho | `ui/ContextMenu.tsx` | Menu armado a mano |
| Panel desde abajo en el celu | `Sheet.tsx` / `ActionSheet.tsx` | Modal centrado |

Si un primitivo se esta estilando para parecer otro, frenar: el manejo de foco es distinto y confunde al siguiente.

## 3. Cancel y Cerrar

Cancelar y Cerrar van siempre como ghost: `Button variant="ghost"` en desktop; en mobile `border border-border bg-bg-secondary active:bg-card`. Nunca son primarios ni destructivos (cancelar no destruye nada).

## 4. El copy no exagera

Prometer solo lo que el codigo garantiza. Mal: "las sesiones no se interrumpen". Bien: "las consolas siguen abiertas mientras la app este abierta". Nada de "siempre", "nunca" ni "instantaneo" si hay un caso que lo rompe.

## 5. Tooltips

Un tooltip nombra el control ("Reiniciar consola"); no ensena, no convence y no advierte. Lo que hay que leer para actuar va visible en la UI, y los errores van inline. Delay por defecto 350 ms (200 ms en los glifos de estado, E4-FR-10). No se ponen tooltips sobre controles que ya tienen label visible.

## 6. Chips de atajo

Un chip de atajo muestra el binding real de `src/renderer/lib/keymap.ts` (lo que el usuario remapeo, no el default) y se arma desde el keymap, nunca escrito a mano en el string. No van en Cancelar ni en Cerrar (Esc es implicito). Si la accion no tiene atajo, no hay chip.

## 7. Escala de iconos

Iconos de `lucide-react`, solo estos tamanos:

| Tamano | Uso |
|---|---|
| 13 | Dentro de filas densas, chips y badges |
| 15 | Toolbars, menus contextuales, header del pane |
| 16 | Botones con label |
| 18 | Titulos de modal y de seccion |

## 8. Tokens

Desktop (`src/renderer/styles/globals.css`, `@theme`) y mobile (`src/mobile/src/index.css`) usan los mismos nombres, asi las clases se leen igual:

| Rol | Clase | Desktop | Mobile |
|---|---|---|---|
| Fondo de la app / superficie | `bg-bg-primary` / `bg-bg-secondary` | igual | igual (el tema lo empuja el desktop) |
| Tarjetas, paneles, hover de ghost | `bg-card` | igual | igual |
| Bordes y separadores | `border-border` | igual | igual |
| Texto / texto secundario | `text-text-primary` / `text-text-secondary` | igual | igual |
| Radio de boton | `rounded-btn` | 8 px | 10 px |
| Radio de tarjeta / modal | `rounded-card` / `rounded-modal` | 12 / 16 px | 12 / 16 px |
| Boton primario | gradiente violeta-azul | `Button variant="primary"` (135deg, `accent-violet` a `accent-blue`) | `PrimaryButton` de `InfoScreen.tsx` (`bg-accent-violet` solido, alto 48 px) |

El gradiente violeta-azul es solo para el boton primario: ni fondos, ni bordes, ni iconos (el logo es la unica excepcion). Ningun hex nuevo en componentes si un token ya lo cubre.

Tokens de estado (los mismos hex en desktop y mobile, declarados en los dos `@theme` como `--color-state-*`, clases `bg-state-*` / `text-state-*`):

| Estado | Token | Hex | Como se dibuja |
|---|---|---|---|
| `working` | `state-working` | `#8b5cf6` | Violeta animado (pulso en desktop, anillo que gira cada 0,8 s en mobile) |
| `action` | `state-action` | `#f59e0b` | Ambar con halo (`ring-2` al 30%) |
| `done` | `state-done` | `#22c55e` | Verde |
| `error` | `state-error` | `#ef4444` | Rojo con halo |
| `idle` | `state-idle` | `#6b7280` | Gris (al 40% en mobile) |
| `unknown` | - | - | Anillo hueco `ring-1 ring-text-secondary` |

`ui/StatusDot.tsx` todavia usa los hex literales; quien lo toque pasa a `bg-state-*`. Con `prefers-reduced-motion` las animaciones quedan quietas.

## 9. Color solo para estados

La UI es monocromatica. Ambar, rojo, verde y violeta significan estado, nunca decoracion. El color nunca es la unica senal: va con glifo, texto o `aria-label` ("Claude: esperando tu respuesta"). Hay un unico boton primario por pantalla, en desktop y en mobile; el resto son ghost o secundarios.

## 10. i18n obligatoria

Todo string visible tiene clave en es y en en: desktop `src/renderer/i18n/{es,en}.ts`, main `src/main/i18n.ts`, mobile `src/mobile/src/lib/i18n.ts`. En es se escribe con tildes y con voseo ("Elegí una carpeta", "Tocá para reintentar", "Claude terminó"). Nada de strings literales en JSX, ni siquiera temporales.

## 11. Sin em dash ni en dash

Prohibidos U+2014 y U+2013 en cualquier archivo: UI, codigo, comentarios, docs y commits. Se usa un guion comun "-". `scripts/check-brand.cjs` (dentro de `npm test`) falla si aparece uno.

## 12. Atribucion

Las secciones 2, 5 y 6 adaptan texto de `docs/STYLEGUIDE.md` de stablyai/orca (licencia MIT, Copyright (c) 2026 Lovecast Inc.). El texto completo de la licencia esta en `THIRD_PARTY_NOTICES.md`. Todo archivo de codigo que porte o adapte codigo de ese proyecto lleva en su primera linea `// Adaptado de stablyai/orca (MIT) - <ruta original>`.
