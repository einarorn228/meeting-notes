/**
 * Tiny, dependency-free, XSS-safe markdown renderer. Everything is rendered through React nodes (never innerHTML).
 * Supports: # headings (1-4), paragraphs, unordered/ordered lists, task lists, blockquotes, horizontal rules,
 * fenced code, and inline **bold**, *italic*, `code`, ~~strike~~ and [links](url).
 */
import type { ReactNode } from 'react'
import { api } from '@/api'

type Block =
  | { type: 'h'; level: number; text: string }
  | { type: 'p'; text: string }
  | { type: 'ul'; items: { text: string; checked?: boolean }[] }
  | { type: 'ol'; items: string[] }
  | { type: 'quote'; text: string }
  | { type: 'hr' }
  | { type: 'code'; text: string }

export function parseBlocks(md: string): Block[] {
  const lines = (md ?? '').replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  const flushPara = (buf: string[]): void => {
    if (buf.length) blocks.push({ type: 'p', text: buf.join(' ') })
    buf.length = 0
  }
  const para: string[] = []
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed === '') {
      flushPara(para)
      i++
      continue
    }
    if (trimmed.startsWith('```')) {
      flushPara(para)
      const buf: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith('```')) buf.push(lines[i++])
      i++
      blocks.push({ type: 'code', text: buf.join('\n') })
      continue
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(trimmed)
    if (h) {
      flushPara(para)
      blocks.push({ type: 'h', level: h[1].length, text: h[2].replace(/\s#+$/, '') })
      i++
      continue
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushPara(para)
      blocks.push({ type: 'hr' })
      i++
      continue
    }
    if (/^[-*+]\s+/.test(trimmed)) {
      flushPara(para)
      const items: { text: string; checked?: boolean }[] = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        let text = lines[i].replace(/^\s*[-*+]\s+/, '')
        let checked: boolean | undefined
        const task = /^\[([ xX])\]\s+(.*)$/.exec(text)
        if (task) {
          checked = task[1] !== ' '
          text = task[2]
        }
        // continuation lines (indented, not a new bullet)
        i++
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i])) {
          text += ' ' + lines[i].trim()
          i++
        }
        items.push({ text, checked })
      }
      blocks.push({ type: 'ul', items })
      continue
    }
    if (/^\d+[.)]\s+/.test(trimmed)) {
      flushPara(para)
      const items: string[] = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        let text = lines[i].replace(/^\s*\d+[.)]\s+/, '')
        i++
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i])) {
          text += ' ' + lines[i].trim()
          i++
        }
        items.push(text)
      }
      blocks.push({ type: 'ol', items })
      continue
    }
    if (trimmed.startsWith('>')) {
      flushPara(para)
      const buf: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('>')) buf.push(lines[i++].trim().replace(/^>\s?/, ''))
      blocks.push({ type: 'quote', text: buf.join(' ') })
      continue
    }
    para.push(trimmed)
    i++
  }
  flushPara(para)
  return blocks
}

const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|~~[^~]+~~|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g

export function renderInline(text: string, keyPrefix = 'i'): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  INLINE.lastIndex = 0
  while ((m = INLINE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    const key = `${keyPrefix}-${k++}`
    if (tok.startsWith('**') || tok.startsWith('__')) out.push(<strong key={key}>{renderInline(tok.slice(2, -2), key)}</strong>)
    else if (tok.startsWith('`')) out.push(<code key={key}>{tok.slice(1, -1)}</code>)
    else if (tok.startsWith('~~')) out.push(<s key={key}>{tok.slice(2, -2)}</s>)
    else if (tok.startsWith('[')) {
      const lm = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(tok)
      if (lm) {
        const url = lm[2]
        out.push(
          <a
            key={key}
            href={url}
            onClick={(e) => {
              e.preventDefault()
              void api.openExternal(url)
            }}
          >
            {lm[1]}
          </a>
        )
      } else out.push(tok)
    } else out.push(<em key={key}>{renderInline(tok.slice(1, -1), key)}</em>)
    last = m.index + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function Markdown({ text, className }: { text: string; className?: string }): ReactNode {
  const blocks = parseBlocks(text)
  return (
    <div className={`md ${className ?? ''}`}>
      {blocks.map((b, idx) => {
        const key = `b${idx}`
        switch (b.type) {
          case 'h': {
            const level = Math.min(4, b.level + 1) // h1 in markdown becomes h2 in the page
            const Tag = `h${level}` as 'h2' | 'h3' | 'h4'
            return <Tag key={key}>{renderInline(b.text, key)}</Tag>
          }
          case 'p':
            return <p key={key}>{renderInline(b.text, key)}</p>
          case 'ul':
            return (
              <ul key={key}>
                {b.items.map((it, j) => (
                  <li key={j} className={it.checked !== undefined ? 'task' : undefined}>
                    {it.checked !== undefined && <input type="checkbox" checked={it.checked} readOnly />}
                    <span>{renderInline(it.text, `${key}-${j}`)}</span>
                  </li>
                ))}
              </ul>
            )
          case 'ol':
            return (
              <ol key={key}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it, `${key}-${j}`)}</li>
                ))}
              </ol>
            )
          case 'quote':
            return <blockquote key={key}>{renderInline(b.text, key)}</blockquote>
          case 'hr':
            return <hr key={key} />
          case 'code':
            return (
              <pre key={key}>
                <code>{b.text}</code>
              </pre>
            )
        }
      })}
    </div>
  )
}
