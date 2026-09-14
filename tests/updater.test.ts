import { describe, it, expect, vi } from 'vitest'

// The updater module reaches for Electron and electron-updater at import time; neither exists under vitest.
vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0-test', isPackaged: false } }))
vi.mock('electron-updater', () => ({ default: { autoUpdater: { on: () => {}, checkForUpdates: async () => {}, quitAndInstall: () => {} } } }))

const { canSelfUpdate } = await import('../src/main/updater')

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
