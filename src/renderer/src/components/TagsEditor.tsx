import { useState, type ReactNode } from 'react'
import { Icon } from './Icons'
import { useT } from '@/i18n'

export function TagsEditor({ tags, onChange, readOnly }: { tags: string[]; onChange: (tags: string[]) => void; readOnly?: boolean }): ReactNode {
  const t = useT()
  const [draft, setDraft] = useState('')
  const add = (): void => {
    const v = draft.trim().replace(/^#/, '')
    if (!v) return
    if (!tags.includes(v)) onChange([...tags, v])
    setDraft('')
  }
  return (
    <div className="tags">
      {tags.map((tag) => (
        <span key={tag} className="tag">
          <Icon name="tag" size={11} />
          {tag}
          {!readOnly && (
            <button type="button" className="tag-remove" onClick={() => onChange(tags.filter((x) => x !== tag))} aria-label={t('common.remove')}>
              <Icon name="x" size={11} />
            </button>
          )}
        </span>
      ))}
      {!readOnly && (
        <input
          className="tag-input"
          value={draft}
          placeholder={t('meeting.tagPlaceholder')}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={add}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              add()
            } else if (e.key === 'Backspace' && draft === '' && tags.length) onChange(tags.slice(0, -1))
          }}
        />
      )}
    </div>
  )
}
