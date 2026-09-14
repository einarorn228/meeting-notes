import { describe, it, expect } from 'vitest'
import { matchApps } from '../src/main/detect/apps'

describe('matchApps', () => {
  it('detects Teams in a call from the Windows window title and prefers in-call apps', () => {
    const procs = [
      { name: 'explorer', title: '' },
      { name: 'ms-teams', title: 'Stöðufundur | Microsoft Teams' },
      { name: 'zoom', title: undefined }
    ]
    const found = matchApps(procs, ['teams', 'zoom', 'meet'])
    expect(found.map((f) => f.app)).toEqual(['teams', 'zoom'])
    expect(found[0].windowTitle).toContain('Microsoft Teams')
  })
  it('ignores disabled apps and unrelated processes', () => {
    expect(matchApps([{ name: 'slack' }, { name: 'chrome' }], ['teams'])).toEqual([])
    expect(matchApps([{ name: 'slack' }], ['slack']).length).toBe(1)
  })
})
