import { useCallback, useEffect, useRef } from 'react'
import {
  DockviewReact,
  themeDark,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
  type SerializedDockview,
} from 'dockview'
import 'dockview/dist/styles/dockview.css'
import './dock-theme.css'
import type { AgentPreset, Pane, Workspace } from '@shared/types'
import { useAppStore } from '@/lib/store'
import { resolveLaunch } from '@/lib/launch'
import { TerminalPane } from '@/components/terminal/TerminalPane'

interface PanelParams {
  paneId: string
  cwd?: string
  initialCommand?: string
  fontSize?: number
}

function TerminalPanel(props: IDockviewPanelProps<PanelParams>) {
  const { paneId, cwd, initialCommand, fontSize } = props.params
  return (
    <TerminalPane paneId={paneId} cwd={cwd} initialCommand={initialCommand} fontSize={fontSize} />
  )
}

const components = { terminal: TerminalPanel }

function addPanel(
  api: DockviewApi,
  pane: Pane,
  workspace: Workspace,
  presets: AgentPreset[],
  fontSize: number,
): void {
  const { cwd, initialCommand } = resolveLaunch(pane, workspace, presets)
  const isFirst = api.panels.length === 0
  api.addPanel<PanelParams>({
    id: pane.id,
    component: 'terminal',
    title: pane.title,
    params: { paneId: pane.id, cwd, initialCommand, fontSize },
    position: isFirst ? undefined : { direction: 'right' },
  })
}

/**
 * Renders one workspace as a dockview mosaic. Panes are the source of truth in
 * the store; this component restores the saved layout, reconciles dockview
 * panels against `workspace.panes`, persists layout changes, and propagates
 * user-initiated panel closes back to the store.
 */
export function DockArea({ workspace }: { workspace: Workspace }) {
  const apiRef = useRef<DockviewApi | null>(null)
  const have = useRef<Set<string>>(new Set())
  const layoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const removePane = useAppStore((s) => s.removePane)
  const saveLayout = useAppStore((s) => s.saveLayout)
  const presets = useAppStore((s) => s.presets)
  const fontSize = useAppStore((s) => s.settings.fontSize)

  const reconcile = useCallback(
    (api: DockviewApi) => {
      for (const pane of workspace.panes) {
        if (!have.current.has(pane.id)) {
          addPanel(api, pane, workspace, presets, fontSize)
          have.current.add(pane.id)
        }
      }
      for (const id of [...have.current]) {
        if (!workspace.panes.some((p) => p.id === id)) {
          const panel = api.getPanel(id)
          if (panel) api.removePanel(panel)
          have.current.delete(id)
        }
      }
    },
    [workspace, presets, fontSize],
  )

  const onReady = (event: DockviewReadyEvent): void => {
    apiRef.current = event.api
    have.current = new Set()

    // Register listeners BEFORE building panels so the initial layout (and any
    // restore) is captured and persisted too.
    event.api.onDidRemovePanel((panel) => {
      if (have.current.has(panel.id)) {
        have.current.delete(panel.id)
        removePane(workspace.id, panel.id)
      }
    })

    event.api.onDidLayoutChange(() => {
      if (layoutTimer.current) clearTimeout(layoutTimer.current)
      layoutTimer.current = setTimeout(() => {
        if (apiRef.current) saveLayout(workspace.id, apiRef.current.toJSON())
      }, 500)
    })

    if (workspace.layout) {
      try {
        event.api.fromJSON(workspace.layout as SerializedDockview)
        for (const panel of event.api.panels) have.current.add(panel.id)
      } catch {
        // Malformed layout — reconcile rebuilds panels from panes below.
      }
    }

    reconcile(event.api)
  }

  useEffect(() => {
    if (apiRef.current) reconcile(apiRef.current)
  }, [reconcile])

  return (
    <DockviewReact
      onReady={onReady}
      components={components}
      theme={themeDark}
      className="sn-dock h-full w-full"
    />
  )
}
