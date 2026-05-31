import { useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import type { Snippet } from '@shared/types'
import { useAppStore } from '@/lib/store'
import { useT } from '@/i18n'
import { inputCls, labelCls } from '../ui'
import { cn } from '@/lib/cn'

export function SnippetsSection() {
  const t = useT()
  const snippets = useAppStore((s) => s.snippets)
  const saveSnippet = useAppStore((s) => s.saveSnippet)
  const deleteSnippet = useAppStore((s) => s.deleteSnippet)
  const newSnippetId = useAppStore((s) => s.newSnippetId)
  const [editing, setEditing] = useState<Snippet | null>(null)

  if (editing) {
    return (
      <SnippetEditor
        initial={editing}
        onSave={(snip) => {
          saveSnippet(snip)
          setEditing(null)
        }}
        onCancel={() => setEditing(null)}
      />
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-text-secondary">{t('snippets.hint')}</p>

      {snippets.map((snip) => (
        <div
          key={snip.id}
          className="flex items-center gap-3 rounded-card border border-border bg-bg-secondary px-3 py-2.5"
        >
          <div className="min-w-0 flex-1">
            <span className="block truncate text-sm text-text-primary">{snip.name}</span>
            <span className="block truncate font-mono text-[11px] text-text-secondary">
              {snip.text}
            </span>
          </div>
          <button
            onClick={() => setEditing(snip)}
            className="rounded p-1.5 text-text-secondary hover:text-text-primary"
            title={t('settings.edit')}
          >
            <Pencil size={15} />
          </button>
          <button
            onClick={() => deleteSnippet(snip.id)}
            className="rounded p-1.5 text-text-secondary hover:text-red-400"
            title={t('ctx.delete')}
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}

      <button
        onClick={() => setEditing({ id: newSnippetId(), name: '', text: '' })}
        className="flex w-full items-center justify-center gap-2 rounded-card border border-dashed border-border py-2.5 text-sm text-text-secondary transition-colors hover:border-accent-violet/40 hover:text-text-primary"
      >
        <Plus size={16} />
        {t('snippets.new')}
      </button>
    </div>
  )
}

function SnippetEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: Snippet
  onSave: (snippet: Snippet) => void
  onCancel: () => void
}) {
  const t = useT()
  const [name, setName] = useState(initial.name)
  const [text, setText] = useState(initial.text)

  return (
    <div className="space-y-4">
      <div>
        <label className={labelCls}>{t('snippets.name')}</label>
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <label className={labelCls}>{t('snippets.text')}</label>
        <textarea
          className={cn(inputCls, 'h-40 resize-none py-2 font-mono')}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="rounded-btn border border-border px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
        >
          {t('common.cancel')}
        </button>
        <button
          onClick={() => onSave({ id: initial.id, name: name.trim() || 'Snippet', text })}
          className="rounded-btn bg-[linear-gradient(135deg,var(--color-accent-violet),var(--color-accent-blue))] px-4 py-2 text-sm font-medium text-white hover:brightness-110"
        >
          {t('common.save')}
        </button>
      </div>
    </div>
  )
}
