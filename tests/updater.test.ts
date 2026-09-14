import { describe, it, expect, vi } from 'vitest'

// The updater module reaches for Electron and electron-updater at import time; neither exists under vitest.
vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0-test', isPackaged: false } }))
vi.mock('electron-updater', () => ({ default: { autoUpdater: { on: () => {}, checkForUpdates: async () => {}, quitAndInstall: () => {} } } }))

const { canSelfUpdate, updateErrorMessage } = await import('../src/main/updater')

describe('canSelfUpdate', () => {
  it('is true for Windows, which ships an NSIS installer the updater can run', () => {
    expect(canSelfUpdate('win32')).toBe(true)
  })

  it('is false on macOS, where Squirrel.Mac refuses this unsigned build', () => {
    expect(canSelfUpdate('darwin')).toBe(false)
  })

  it('is true on Linux only inside an AppImage; a .deb install would need a root prompt', () => {
    expect(canSelfUpdate('linux', true)).toBe(true)
    expect(canSelfUpdate('linux', false)).toBe(false)
  })
})

describe('updateErrorMessage', () => {
  it('explains a half-published release instead of showing the raw 404 and headers', () => {
    // Each platform job uploads into the same release, so a check landing mid-upload sees this.
    const raw = new Error(
      'Cannot find latest.yml in the latest release artifacts (https://github.com/o/r/releases/download/v0.1.5/latest.yml): HttpError: 404\n' +
        'Headers: {\n  "server": "github.com"\n}'
    )
    const message = updateErrorMessage(raw)
    expect(message).toBe('Ný útgáfa er í vinnslu og ekki fullbúin. Forritið reynir aftur eftir smá stund.')
    expect(message).not.toContain('404')
  })

  it('explains a network failure', () => {
    expect(updateErrorMessage(new Error('net::ERR_INTERNET_DISCONNECTED'))).toContain('Náði ekki sambandi')
  })

  it('keeps an unrecognised error but drops the stack trace after the first line', () => {
    const message = updateErrorMessage(new Error('Something specific broke\n    at Foo.bar (baz.js:1:2)'))
    expect(message).toBe('Something specific broke')
  })
})
