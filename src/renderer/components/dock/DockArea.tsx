import { useCallback, useEffect, useRef } from 'react'
import {
  DockviewReact,
  themeDark,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
} from 'dockview'
import 'dockview/dist/styles/dockview.css'
import './dock-theme.css'
import type { Pane, Workspace } from '@shared/types'
import { useAppStore } from '@/lib/store'
import { TerminalPane } from '@/components/terminal/TerminalPane'

interface PanelParams {
  paneId: string
  cwd?: string
  shell?: string
}

function TerminalPanel(props: IDockviewPanelProps<PanelParams>) {
  const { paneId, cwd, shell } = props.params
  return <TerminalPane paneId={paneId} cwd={cwd} shell={shell} />
}

const components = { terminal: TerminalPanel }

function addPanel(api: DockviewApi, pane: Pane, workspace: Workspace): void {
  const isFirst = api.panels.length === 0
  api.addPanel<PanelParams>({
    id: pane.id,
    component: 'terminal',
    title: pane.title,
    params: { paneId: pane.id, cwd: pane.cwd ?? workspace.cwd, shell: pane.command },
    position: isFirst ? undefined : { direction: 'right' },
  })
}

/**
 * Renders one workspace as a dockview mosaic. Panes are the source of truth in
 * the store; this component reconciles dockview panels against `workspace.panes`
 * and propagates user-initiated panel closes back to the store.
 */
export function DockArea({ workspace }: { workspace: Workspace }) {
  const apiRef = useRef<DockviewApi | null>(null)
  const have = useRef<Set<string>>(new Set())
  const removePane = useAppStore((s) => s.removePane)

  const reconcile = useCallback(
    (api: DockviewApi) => {
      for (const pane of workspace.panes) {
        if (!have.current.has(pane.id)) {
          addPanel(api, pane, workspace)
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
    [workspace],
  )

  const onReady = (event: DockviewReadyEvent): void => {
    apiRef.current = event.api
    have.current = new Set()
    reconcile(event.api)
    event.api.onDidRemovePanel((panel) => {
      if (have.current.has(panel.id)) {
        have.current.delete(panel.id)
        removePane(workspace.id, panel.id)
      }
    })
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
