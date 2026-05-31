import { useEffect } from 'react'
import { useAppStore } from './store'
import { eventToAccel, resolveKeymap, type ActionId } from './keymap'

/** Sidebar display order: favorites first (matches the Sidebar). */
function displayOrder() {
  return [...useAppStore.getState().workspaces].sort(
    (a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0),
  )
}

function runAction(id: ActionId): void {
  const s = useAppStore.getState()
  switch (id) {
    case 'palette':
      s.setPaletteOpen(!s.paletteOpen)
      break
    case 'openSettings':
      s.setSettingsOpen(true)
      break
    case 'newWorkspace':
      s.setWizardOpen(true)
      break
    case 'toggleSidebar':
      s.toggleSidebar()
      break
    case 'newConsole':
      if (s.activeWorkspaceId) s.addPane(s.activeWorkspaceId)
      break
    case 'workspaceFlip': {
      const prev = s.previousWorkspaceId
      if (prev && prev !== s.activeWorkspaceId && s.workspaces.some((w) => w.id === prev)) {
        s.setActive(prev)
      }
      break
    }
    case 'workspaceNext':
    case 'workspacePrev': {
      const list = displayOrder()
      if (list.length < 2) break
      const idx = list.findIndex((w) => w.id === s.activeWorkspaceId)
      const cur = idx < 0 ? 0 : idx
      const to =
        id === 'workspaceNext'
          ? (cur + 1) % list.length
          : (cur - 1 + list.length) % list.length
      s.setActive(list[to].id)
      break
    }
  }
}

/**
 * Central keyboard dispatcher (S13). Resolves each keydown against the active
 * keymap (defaults + user overrides) and runs the matching action. Attached on
 * the capture phase so it wins over xterm. Alt+1..9 (jump to Nth workspace) is
 * a fixed numeric family, not part of the remappable keymap.
 */
export function useGlobalKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
        const target = displayOrder()[Number(e.key) - 1]
        if (target) {
          e.preventDefault()
          e.stopPropagation()
          useAppStore.getState().setActive(target.id)
        }
        return
      }

      const accel = eventToAccel(e)
      if (!accel) return
      const keymap = resolveKeymap(useAppStore.getState().settings.keymap)
      for (const id of Object.keys(keymap) as ActionId[]) {
        if (keymap[id] === accel) {
          e.preventDefault()
          e.stopPropagation()
          runAction(id)
          return
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}
