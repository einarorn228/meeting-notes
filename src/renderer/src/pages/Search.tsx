import { useEffect, useState, type ReactNode } from 'react'
import type { SearchResult } from '@shared/types'
import { api } from '@/api'
import { useI18n } from '@/i18n'
import { useRouter } from '@/router'
import { Button, Card, Spinner } from '@/components/ui'
import { Icon } from '@/components/Icons'
import { Markdown } from '@/utils/markdown'
import { errorMessage, formatDate, mmss } from '@/utils/format'

export function SearchPage({ initialQuery }: { initialQuery?: string }): ReactNode {
  const { t, locale } = useI18n()
  const { navigate } = useRouter()
  const [query, setQuery] = useState(initialQuery ?? '')
  const [results, setResults] = useState<SearchResult[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [askError, setAskError] = useState<string | null>(null)

  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setResults(null)
      return
    }
    setSearching(true)
    const id = window.setTimeout(() => {
      api
        .searchMeetings(q)
        .then((r) => {
          setResults(r)
          setError(null)
        })
        .catch((err) => setError(errorMessage(err)))
        .finally(() => setSearching(false))
    }, 250)
    return () => window.clearTimeout(id)
  }, [query])

  const ask = async (): Promise<void> => {
    const q = question.trim()
    if (!q || asking) return
    setAsking(true)
    setAskError(null)
    try {
      setAnswer(await api.chatAll(q))
    } catch (err) {
      setAskError(t('chat.failed', { msg: errorMessage(err) }))
    } finally {
      setAsking(false)
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>{t('search.title')}</h1>
      </header>
      <div className="search-box search-box-lg">
        <Icon name="search" size={17} />
        <input autoFocus value={query} placeholder={t('search.placeholder')} onChange={(e) => setQuery(e.target.value)} />
        {searching && <Spinner size={14} />}
      </div>
      <div className="muted small">{t('search.hint')}</div>
      {error && <div className="text-danger">{error}</div>}
      {results && (
        <section className="section">
          <h2 className="section-title">{results.length === 0 ? t('search.noResults') : t('search.results', { n: results.length })}</h2>
          <div className="list">
            {results.map((r, i) => (
              <button key={`${r.meetingId}-${r.segmentId ?? i}`} type="button" className="list-item" onClick={() => navigate({ name: 'meeting', id: r.meetingId, tab: r.segmentId ? 'transcript' : undefined, time: r.time })}>
                <div className="list-main">
                  <div className="list-title">{r.title}</div>
                  <div className="list-preview">{r.snippet}</div>
                </div>
                <div className="list-meta">
                  <span>{formatDate(r.createdAt, locale, { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                  {r.time !== undefined && <span className="mono">{mmss(r.time)}</span>}
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      <Card title={<><Icon name="sparkles" size={15} /> {t('chat.askAll')}</>} className="section">
        <p className="muted small">{t('chat.askAllHint')}</p>
        <div className="row gap-sm">
          <input
            className="input grow"
            value={question}
            placeholder={t('chat.allPlaceholder')}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void ask()}
          />
          <Button variant="primary" loading={asking} onClick={ask} disabled={!question.trim()}>
            {asking ? t('chat.thinking') : t('chat.send')}
          </Button>
        </div>
        {askError && <div className="text-danger small">{askError}</div>}
        {answer && (
          <div className="answer">
            <Markdown text={answer} />
            <Button size="sm" variant="ghost" icon="copy" onClick={() => void api.copyToClipboard(answer)}>
              {t('common.copy')}
            </Button>
          </div>
        )}
      </Card>
    </div>
  )
}
