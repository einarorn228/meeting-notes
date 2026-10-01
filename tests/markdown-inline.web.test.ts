import { describe, it, expect, vi } from 'vitest'

vi.mock('@/api', () => ({ api: { openExternal: vi.fn() } }))

import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderInline } from '../src/renderer/src/utils/markdown'

function plain(nodes: ReactNode): string {
  if (Array.isArray(nodes)) return nodes.map(plain).join('')
  if (isValidElement(nodes)) return plain((nodes as ReactElement<{ children?: ReactNode }>).props.children)
  return nodes == null ? '' : String(nodes)
}

// Bold and italic recurse into renderInline. With one shared /g regex the inner call reset lastIndex, so the
// outer loop matched the same token forever and the renderer ran out of memory: a white window.
describe('renderInline', () => {
  it('finishes on bold text and keeps the words', () => {
    const out = renderInline('a **b** c')
    expect(out).toHaveLength(3)
    expect(plain(out)).toBe('a b c')
  })

  it('finishes on italic text and on several tokens in one line', () => {
    expect(plain(renderInline('*x* og _y_'))).toBe('x og y')
    const out = renderInline('**Ákvörðun:** gera `x` og **y** fyrir *föstudag*')
    expect(plain(out)).toBe('Ákvörðun: gera x og y fyrir föstudag')
    expect(out.filter(isValidElement)).toHaveLength(4)
  })
})
