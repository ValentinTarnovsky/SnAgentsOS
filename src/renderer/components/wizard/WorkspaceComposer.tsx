import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { AlertTriangle, Check, Folder, FolderOpen, Star } from 'lucide-react'
import type { AutomationSettings, GridPreset } from '@shared/types'
import { useAppStore } from '@/lib/store'
import { useT } from '@/i18n'
import { cn } from '@/lib/cn'
import { iconFor } from '@/lib/icons'
import { isFromToast } from '@/lib/toast'
import { setWizardDraftCwd } from '@/lib/openRequest'
import { Button } from '@/components/ui/Button'
import { Tooltip } from '@/components/ui/Tooltip'
import { Toggle } from '@/components/settings/ui'
import {
  COMPOSER_GRIDS,
  basenameOf,
  composerKeyAction,
  composerPanes,
  folderSuggestions,
  nextAgentIndex,
  resolveDefaultPreset,
} from './composerModel'
import { initialWizardFocus, trapTabIndex } from './wizardKeys'
import { rememberFlowFocus } from './flowFocus'

const CREATE_KEYS = ['Ctrl', 'Enter']
/** Wait after the last keystroke before asking main whether the folder exists. */
const DIR_CHECK_DEBOUNCE_MS = 250

const FOCUSABLE =
  'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement)
}

const segBtn = (on: boolean): string =>
  cn(
    'flex-1 rounded-[6px] px-3 py-1 text-sm font-medium transition-colors',
    on ? 'bg-accent-violet text-white' : 'text-text-secondary hover:text-text-primary',
  )

const AUTOMATION_BASE: AutomationSettings = { defaultAgentPresetId: '', composerCreateAnother: false }

const fieldLabel ='mb-1.5 block text-xs font-medium text-text-secondary'

/**
 * Workspace composer (E8-FR-08/09): one 560 px card that creates a workspace
 * from a folder, an agent, a grid of 1/2/4 and an optional first prompt.
 * Ctrl+Enter creates from any field; "Create another" keeps the card open
 * with the agent, grid and profile. "Advanced..." hands the draft to the
 * 3-step wizard.
 */
export function WorkspaceComposer() {
  const t = useT()
  const open = useAppStore((s) => s.composerOpen)
  const flowOpen = useAppStore((s) => s.wizardOpen)
  const prefill = useAppStore((s) => s.wizardPrefill)
  const presets = useAppStore((s) => s.presets)
  const connections = useAppStore((s) => s.connections)
  const workspaces = useAppStore((s) => s.workspaces)
  const automation = useAppStore((s) => s.settings.automation)
  const setWizardOpen = useAppStore((s) => s.setWizardOpen)
  const openAdvancedWizard = useAppStore((s) => s.openAdvancedWizard)
  const createWorkspaceFull = useAppStore((s) => s.createWorkspaceFull)
  const updateSettings = useAppStore((s) => s.updateSettings)

  const [cwd, setCwd] = useState('')
  const [name, setName] = useState('')
  /** The user typed a name: the folder stops renaming it. */
  const [nameTouched, setNameTouched] = useState(false)
  const [presetId, setPresetId] = useState('')
  const [grid, setGrid] = useState<GridPreset>(1)
  const [prompt, setPrompt] = useState('')
  const [setupId, setSetupId] = useState('')
  const [missing, setMissing] = useState(false)
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [suggestIdx, setSuggestIdx] = useState(-1)
  const [creating, setCreating] = useState(false)
  const [focusReq, setFocusReq] = useState(0)

  const dialogRef = useRef<HTMLDivElement>(null)
  const cwdRef = useRef<HTMLInputElement>(null)
  /** Element focused before opening; focus returns there on cancel. */
  const prevFocus = useRef<HTMLElement | null>(null)
  /** The card closed by creating or by handing off to the wizard: no focus restore. */
  const handedOff = useRef(false)

  const createAnother = automation?.composerCreateAnother === true
  const defaultId = automation?.defaultAgentPresetId ?? ''

  // Reset whenever the card opens (with the prefill, if any).
  useEffect(() => {
    if (open) {
      if (!prevFocus.current && document.activeElement instanceof HTMLElement) prevFocus.current = document.activeElement
      handedOff.current = false
      const s = useAppStore.getState()
      const dir = prefill?.cwd ?? ''
      setCwd(dir)
      setName(prefill?.name ?? (dir ? basenameOf(dir) : ''))
      setNameTouched(false)
      setPresetId(resolveDefaultPreset(s.presets, s.settings.automation?.defaultAgentPresetId))
      setGrid(1)
      setPrompt('')
      setSetupId('')
      setMissing(false)
      setSuggestOpen(false)
      setSuggestIdx(-1)
      setFocusReq((n) => n + 1)
      return
    }
    const prev = prevFocus.current
    prevFocus.current = null
    if (handedOff.current) {
      // "Advanced...": the wizard restores it on cancel.
      if (useAppStore.getState().wizardOpen) rememberFlowFocus(prev)
      return
    }
    if (prev && prev.isConnected) prev.focus()
  }, [open, prefill])

  // "Open in SnAgentsOS" never overwrites a folder being typed here (E4-FR-33).
  useEffect(() => {
    if (open) setWizardDraftCwd(cwd)
    else if (!flowOpen) setWizardDraftCwd(null)
  }, [open, flowOpen, cwd])

  // A preset deleted while the card is open: fall back to the default.
  useEffect(() => {
    if (open && !presets.some((p) => p.id === presetId)) setPresetId(resolveDefaultPreset(presets, defaultId))
  }, [open, presets, presetId, defaultId])

  // "The folder does not exist" hint (never blocks, like the wizard).
  useEffect(() => {
    const dir = cwd.trim()
    if (!open || !dir) {
      setMissing(false)
      return
    }
    let live = true
    const timer = setTimeout(() => {
      void Promise.resolve()
        .then(() => window.snApi.fs.dirExists(dir))
        .then((exists) => {
          if (live) setMissing(exists === false)
        })
        .catch(() => undefined)
    }, DIR_CHECK_DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [open, cwd])

  // Move focus inside once the reset draft rendered: the folder input on an
  // empty draft, the primary button when the folder came prefilled.
  useEffect(() => {
    if (!open || focusReq === 0) return
    const root = dialogRef.current
    if (!root) return
    const where = initialWizardFocus(cwd)
    const el = where === 'cwd' ? cwdRef.current : root.querySelector<HTMLElement>('[data-composer-primary]')
    ;(el ?? root).focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusReq])

  // While open no key reaches the console behind: a keydown aimed outside the
  // card (a terminal that kept focus, the body) is swallowed in the capture
  // phase and focus is pulled back in. Overlays above it keep their keyboard.
  useEffect(() => {
    if (!open) return
    const guard = (e: KeyboardEvent): void => {
      const root = dialogRef.current
      const target = e.target as Element | null
      const behind = !target || target === document.body || target === document.documentElement || !!target.closest?.('.xterm')
      if (!root || !behind || root.contains(target)) return
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setWizardOpen(false)
        return
      }
      ;(cwdRef.current ?? root).focus()
    }
    window.addEventListener('keydown', guard, true)
    return () => window.removeEventListener('keydown', guard, true)
  }, [open, setWizardOpen])

  const suggestions = useMemo(() => folderSuggestions(workspaces, cwd), [workspaces, cwd])

  if (!open) return null

  const hasCwd = cwd.trim().length > 0
  const selected = presets.find((p) => p.id === presetId)
  const promptDisabled = !selected || selected.type === 'shell'
  const showSuggest = suggestOpen && suggestions.length > 0

  const changeCwd = (dir: string): void => {
    setCwd(dir)
    if (!nameTouched) setName(basenameOf(dir))
  }
  const pickSuggestion = (dir: string): void => {
    changeCwd(dir)
    setSuggestOpen(false)
    setSuggestIdx(-1)
  }
  const browse = async (): Promise<void> => {
    const dir = await window.snApi.dialog.openDirectory()
    if (dir) changeCwd(dir)
  }

  const patchAutomation = (patch: Partial<AutomationSettings>): void => {
    updateSettings({ automation: { ...AUTOMATION_BASE, ...useAppStore.getState().settings.automation, ...patch } })
  }
  // The star persists the default agent (E8-FR-08); a second click unsets it.
  const setDefault = (id: string): void => {
    patchAutomation({ defaultAgentPresetId: defaultId === id ? '' : id })
    setPresetId(id)
  }
  const setCreateAnother = (v: boolean): void => patchAutomation({ composerCreateAnother: v })

  const onCreate = (): void => {
    if (!hasCwd || creating) return
    setCreating(true)
    const dir = cwd.trim()
    createWorkspaceFull({
      name: name.trim() || basenameOf(dir) || 'workspace',
      cwd: dir,
      grid,
      panes: composerPanes(selected, grid),
      setupId: setupId || undefined,
      firstPrompt: promptDisabled ? undefined : prompt,
    })
    setCreating(false)
    if (createAnother) {
      // E8-FR-09: the card stays with the agent, grid and profile.
      setCwd('')
      setName('')
      setNameTouched(false)
      setPrompt('')
      setMissing(false)
      setSuggestIdx(-1)
      cwdRef.current?.focus()
      return
    }
    // The new workspace's console takes the focus.
    handedOff.current = true
    setWizardOpen(false)
  }

  const onAdvanced = (): void => {
    handedOff.current = true
    openAdvancedWizard({ name: nameTouched ? name.trim() : '', cwd: cwd.trim(), grid, presetId, setupId })
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (showSuggest) setSuggestOpen(false)
      else setWizardOpen(false)
      return
    }
    if (e.key === 'Tab') {
      const root = dialogRef.current
      if (!root) return
      const items = focusables(root)
      e.preventDefault()
      const next = trapTabIndex(items.length, items.indexOf(document.activeElement as HTMLElement), e.shiftKey)
      items[next]?.focus()
      return
    }
    const action = composerKeyAction(
      { key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing },
      e.target as HTMLElement,
      hasCwd,
    )
    if (!action) return
    e.preventDefault()
    e.stopPropagation()
    if (action === 'create') onCreate()
  }

  const onCwdKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (suggestions.length === 0) return
      e.preventDefault()
      setSuggestOpen(true)
      const n = suggestions.length
      setSuggestIdx((i) => (e.key === 'ArrowDown' ? (i + 1) % n : i <= 0 ? n - 1 : i - 1))
      return
    }
    // Enter on a highlighted suggestion picks it instead of creating.
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && showSuggest && suggestIdx >= 0 && suggestions[suggestIdx]) {
      e.preventDefault()
      e.stopPropagation()
      pickSuggestion(suggestions[suggestIdx])
    }
  }

  const onAgentKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    const next = nextAgentIndex(e.key, index, presets.length)
    if (next === null) return
    e.preventDefault()
    const target = presets[next]
    if (!target) return
    setPresetId(target.id)
    dialogRef.current?.querySelector<HTMLElement>(`[data-composer-agent="${CSS.escape(target.id)}"]`)?.focus()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-6 pt-[10vh]">
      <div className="fixed inset-0 bg-black/60" onClick={(e) => { if (!isFromToast(e)) setWizardOpen(false) }} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="composer-title"
        tabIndex={-1}
        data-composer
        onKeyDown={onKeyDown}
        className="relative z-10 flex w-[560px] max-w-full flex-col rounded-modal border border-border bg-card shadow-[0_20px_48px_-12px_rgba(0,0,0,0.6)] outline-none"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
          <h2 id="composer-title" className="text-base font-semibold text-text-primary">{t('composer.title')}</h2>
          <button
            type="button"
            onClick={onAdvanced}
            data-composer-advanced
            className="rounded px-1 text-xs font-medium text-accent-violet transition-colors hover:text-text-primary hover:underline"
          >
            {t('composer.advanced')}
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {/* Folder */}
          <div>
            <label htmlFor="composer-cwd" className={fieldLabel}>{t('composer.folder')}</label>
            <div className="relative flex items-center gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-2 rounded-btn border border-border bg-bg-primary px-3 py-2 focus-within:border-accent-violet/60">
                <Folder size={15} className="shrink-0 text-accent-violet" />
                <input
                  id="composer-cwd"
                  ref={cwdRef}
                  data-wizard-cwd
                  data-composer-cwd
                  role="combobox"
                  aria-expanded={showSuggest}
                  aria-controls="composer-suggestions"
                  aria-autocomplete="list"
                  autoComplete="off"
                  spellCheck={false}
                  value={cwd}
                  onChange={(e) => {
                    changeCwd(e.target.value)
                    setSuggestOpen(true)
                    setSuggestIdx(-1)
                  }}
                  // The list opens on a click, typing or an arrow, never on focus alone (it would cover the card).
                  onMouseDown={() => setSuggestOpen(true)}
                  onBlur={() => setSuggestOpen(false)}
                  onKeyDown={onCwdKeyDown}
                  placeholder={t('composer.folderPlaceholder')}
                  className="min-w-0 flex-1 bg-transparent font-mono text-sm text-text-primary outline-none placeholder:text-text-secondary"
                />
              </div>
              <button
                type="button"
                onClick={browse}
                data-composer-browse
                className="flex shrink-0 items-center gap-1.5 rounded-btn border border-border bg-card px-3 py-2 text-sm text-text-primary transition-colors hover:border-accent-violet/40"
              >
                <FolderOpen size={15} className="text-accent-violet" />
                {t('common.browse')}
              </button>
              {showSuggest && (
                <div
                  id="composer-suggestions"
                  role="listbox"
                  aria-label={t('composer.suggestions')}
                  data-composer-suggestions
                  className="absolute left-0 right-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-btn border border-border bg-card py-1 shadow-[0_12px_32px_-12px_rgba(0,0,0,0.6)]"
                >
                  {suggestions.map((dir, i) => (
                    <div
                      key={dir}
                      role="option"
                      aria-selected={i === suggestIdx}
                      data-composer-suggestion={dir}
                      // mousedown keeps the input focused (blur would close the list first).
                      onMouseDown={(e) => {
                        e.preventDefault()
                        pickSuggestion(dir)
                      }}
                      className={cn(
                        'cursor-pointer truncate px-3 py-1.5 font-mono text-xs',
                        i === suggestIdx ? 'bg-accent-violet/15 text-text-primary' : 'text-text-secondary hover:bg-bg-secondary hover:text-text-primary',
                      )}
                    >
                      {dir}
                    </div>
                  ))}
                </div>
              )}
            </div>
            {missing && hasCwd && (
              <p data-composer-missing className="mt-1.5 flex items-center gap-1.5 text-xs text-amber-400">
                <AlertTriangle size={12} className="shrink-0" />
                {t('composer.folderMissing')}
              </p>
            )}
          </div>

          {/* Name */}
          <div>
            <label htmlFor="composer-name" className={fieldLabel}>{t('composer.name')}</label>
            <input
              id="composer-name"
              data-composer-name
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setNameTouched(e.target.value.trim().length > 0)
              }}
              placeholder={basenameOf(cwd) || 'workspace'}
              className="w-full rounded-btn border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-accent-violet/50 placeholder:text-text-secondary"
            />
          </div>

          {/* Agent */}
          <div>
            <span id="composer-agent-label" className={fieldLabel}>{t('composer.agent')}</span>
            <div role="radiogroup" aria-labelledby="composer-agent-label" className="flex flex-wrap gap-1.5">
              {presets.map((p, i) => {
                const Icon = iconFor(p.icon)
                const on = p.id === presetId
                const isDefault = defaultId === p.id
                return (
                  <div
                    key={p.id}
                    className={cn(
                      'flex items-center rounded-btn border transition-colors',
                      on ? 'border-accent-violet bg-accent-violet/10' : 'border-border hover:border-accent-violet/40',
                    )}
                  >
                    <button
                      type="button"
                      role="radio"
                      aria-checked={on}
                      tabIndex={on ? 0 : -1}
                      data-composer-agent={p.id}
                      onClick={() => setPresetId(p.id)}
                      onKeyDown={(e) => onAgentKeyDown(e, i)}
                      className={cn('flex items-center gap-1.5 py-1 pl-2.5 pr-1 text-xs outline-none focus-visible:underline', on ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary')}
                    >
                      <Icon size={13} style={{ color: p.color }} />
                      {p.name}
                    </button>
                    <Tooltip label={isDefault ? t('composer.default') : t('composer.setDefault')}>
                      <button
                        type="button"
                        tabIndex={-1}
                        aria-pressed={isDefault}
                        aria-label={isDefault ? t('composer.default') : t('composer.setDefault')}
                        data-composer-star={p.id}
                        onClick={() => setDefault(p.id)}
                        className="flex items-center py-1 pl-0.5 pr-2"
                      >
                        <Star size={12} className={isDefault ? 'fill-amber-400 text-amber-400' : 'text-text-secondary/50 hover:text-amber-400'} />
                      </button>
                    </Tooltip>
                  </div>
                )
              })}
            </div>
          </div>

          <div className={cn('grid gap-4', connections.length > 0 ? 'grid-cols-2' : 'grid-cols-1')}>
            {/* Grid */}
            <div>
              <span id="composer-grid-label" className={fieldLabel}>{t('composer.grid')}</span>
              <div role="radiogroup" aria-labelledby="composer-grid-label" className="flex gap-1 rounded-btn border border-border bg-bg-primary p-1">
                {COMPOSER_GRIDS.map((n) => (
                  <button key={n} type="button" role="radio" aria-checked={grid === n} data-composer-grid={n} onClick={() => setGrid(n)} className={segBtn(grid === n)}>
                    {n}
                  </button>
                ))}
              </div>
            </div>
            {/* Connection profile, only when there is one. */}
            {connections.length > 0 && (
              <div>
                <label htmlFor="composer-profile" className={fieldLabel}>{t('composer.profile')}</label>
                <select
                  id="composer-profile"
                  data-composer-profile
                  value={setupId}
                  onChange={(e) => setSetupId(e.target.value)}
                  className="h-[38px] w-full rounded-btn border border-border bg-bg-primary px-3 text-sm text-text-primary outline-none transition-colors focus:border-accent-violet"
                >
                  <option value="" className="bg-card">{t('wizard.connectionNone')}</option>
                  {connections.map((c) => (
                    <option key={c.id} value={c.id} className="bg-card">{c.name}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* First prompt */}
          <div>
            <label htmlFor="composer-prompt" className={fieldLabel}>
              {t('composer.prompt')}
              <span className="ml-1.5 font-normal text-text-secondary/70">
                {promptDisabled ? t('composer.promptShell') : t('composer.promptHint')}
              </span>
            </label>
            <textarea
              id="composer-prompt"
              data-composer-prompt
              rows={3}
              value={prompt}
              disabled={promptDisabled}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t('composer.promptPlaceholder')}
              className="block w-full resize-none rounded-btn border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-accent-violet/50 placeholder:text-text-secondary disabled:opacity-50"
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
          <label className="flex min-w-0 cursor-pointer items-center gap-2 text-xs text-text-secondary" data-composer-another>
            <Toggle checked={createAnother} onChange={setCreateAnother} />
            <span className="truncate">{t('composer.createAnother')}</span>
          </label>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setWizardOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={onCreate} disabled={!hasCwd || creating} keyHint={CREATE_KEYS} data-composer-primary>
              <Check size={15} />
              {t('common.create')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
