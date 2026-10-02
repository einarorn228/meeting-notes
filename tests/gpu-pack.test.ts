/**
 * The optional GPU pack, from the app's side.
 *
 * CUDA does not recover inside a sidecar that has already failed to load it, so once the pack is in place the
 * sidecar has to be restarted - but never under a meeting that is being transcribed. These tests drive the real
 * SidecarManager against a fake sidecar process.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'gpu-pack-'))
mkdirSync(join(root, 'models', 'aalto-large-v3-is'), { recursive: true })
writeFileSync(join(root, 'models', 'aalto-large-v3-is', 'model.bin'), 'x')

vi.mock('electron', () => ({ app: { getPath: () => root, isPackaged: false, getAppPath: () => root, getVersion: () => '0.0.0' } }))
const settings = vi.hoisted(() => ({ local: { modelId: 'aalto-large-v3-is', device: 'auto', computeType: 'auto', partials: false } }))
vi.mock('../src/main/settings', () => ({ getSettings: () => settings, dataDir: () => root }))

interface FakeProc extends EventEmitter {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  killed: boolean
  env: Record<string, string>
  received: Record<string, unknown>[]
  kill: () => void
  reply: (ev: Record<string, unknown>) => void
}

const procs = vi.hoisted(() => ({ list: [] as unknown[], gpuPack: false }))

vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (_cmd: string, _args: string[], opts: { env: Record<string, string> }) => {
      const p = new EventEmitter() as FakeProc
      p.stdin = new PassThrough()
      p.stdout = new PassThrough()
      p.stderr = new PassThrough()
      p.killed = false
      p.env = opts.env
      p.received = []
      p.reply = (ev) => p.stdout.write(JSON.stringify(ev) + '\n')
      p.kill = () => {
        if (p.killed) return
        p.killed = true
        p.emit('exit', 0, null)
      }
      let buf = ''
      p.stdin.on('data', (d: Buffer) => {
        buf += d.toString()
        let i: number
        while ((i = buf.indexOf('\n')) >= 0) {
          const cmd = JSON.parse(buf.slice(0, i)) as Record<string, unknown>
          buf = buf.slice(i + 1)
          p.received.push(cmd)
          if (cmd.type === 'hello') p.reply({ type: 'ready', cuda: true, gpu_pack: procs.gpuPack, gpu_pack_mb: 397 })
          if (cmd.type === 'load_model') p.reply({ type: 'model_loaded', model_id: cmd.model_id, device: procs.gpuPack ? 'cuda' : 'cpu', compute_type: procs.gpuPack ? 'float16' : 'int8' })
          if (cmd.type === 'shutdown') setTimeout(() => p.kill(), 5)
        }
      })
      procs.list.push(p)
      return p
    }
  }
})

const { SidecarManager } = await import('../src/main/transcription/sidecar')

const all = (): FakeProc[] => procs.list as FakeProc[]
/** The sidecar finishing the install it was asked for (the reply carries that request's id). */
const installed = (): void => {
  const p = (procs.list as FakeProc[]).find((x) => x.received.some((c) => c.type === 'install_gpu'))!
  const cmd = p.received.find((c) => c.type === 'install_gpu')!
  p.reply({ type: 'gpu_installed', request_id: cmd.request_id, target_dir: cmd.target_dir })
}
const last = (): FakeProc => all()[all().length - 1]

function manager(): InstanceType<typeof SidecarManager> {
  const m = new SidecarManager()
  vi.spyOn(m, 'runtime').mockResolvedValue({ cmd: 'fake-stt', args: [] })
  return m
}

beforeEach(() => {
  procs.list = []
  procs.gpuPack = false
  settings.local.device = 'auto'
})

describe('the GPU pack', () => {
  it('tells the sidecar where the pack lives, and reports whether a card and the pack are there', async () => {
    const m = manager()
    await m.ensureStarted()
    expect(last().env.FUNDARRITARI_GPU_DIR).toBe(join(root, 'gpu'))
    expect(m.getStatus().gpu).toEqual({ present: true, installed: false, sizeMb: 397 })
  })

  it('restarts the sidecar once installed, so the next model loads on the GPU', async () => {
    const m = manager()
    await m.ensureModel()
    expect(m.modelInfo?.device).toBe('cpu')
    const installing = m.installGpu()
    await vi.waitFor(() => expect(last().received.some((c) => c.type === 'install_gpu' && c.target_dir === join(root, 'gpu'))).toBe(true))
    procs.gpuPack = true
    installed()
    await installing
    await vi.waitFor(() => expect(all()).toHaveLength(2))
    await vi.waitFor(() => expect(m.modelInfo?.device).toBe('cuda'))
    expect(m.getStatus().gpu?.installed).toBe(true)
  })

  it('waits for a meeting being transcribed to finish before restarting', async () => {
    const m = manager()
    await m.ensureModel()
    m.send({ type: 'start', session_id: 's1' })
    const installing = m.installGpu()
    await vi.waitFor(() => expect(last().received.some((c) => c.type === 'install_gpu')).toBe(true))
    procs.gpuPack = true
    installed()
    await installing
    await new Promise((r) => setTimeout(r, 50))
    expect(all()).toHaveLength(1)
    expect(all()[0].received.some((c) => c.type === 'shutdown')).toBe(false)

    all()[0].reply({ type: 'stopped', session_id: 's1' })
    await vi.waitFor(() => expect(all()).toHaveLength(2))
  })

  it('fetches the pack by itself when a card is there, but not when the user chose the CPU', async () => {
    const m = manager()
    await m.ensureModel()
    const auto = m.installGpuIfUseful()
    await vi.waitFor(() => expect(last().received.some((c) => c.type === 'install_gpu')).toBe(true))
    procs.gpuPack = true
    installed()
    expect(await auto).toBe(true)
    // Installed now, so a second start of the app does not fetch it again.
    expect(await m.installGpuIfUseful()).toBe(false)

    settings.local.device = 'cpu'
    procs.gpuPack = false
    const pinned = manager()
    await pinned.ensureStarted()
    expect(await pinned.installGpuIfUseful()).toBe(false)
    expect(last().received.some((c) => c.type === 'install_gpu')).toBe(false)
  })

  it('keeps the new sidecar when the old one exits after it', async () => {
    const m = manager()
    await m.ensureModel()
    const installing = m.installGpu()
    await vi.waitFor(() => expect(last().received.some((c) => c.type === 'install_gpu')).toBe(true))
    procs.gpuPack = true
    installed()
    await installing
    await vi.waitFor(() => expect(all()).toHaveLength(2))
    await vi.waitFor(() => expect(all()[0].killed).toBe(true))
    // The old process's exit must not be taken for the new one dying.
    expect(() => m.send({ type: 'hello' })).not.toThrow()
    expect(m.getStatus().state).not.toBe('error')
  })

  it('does not cut speaker detection short', async () => {
    const m = manager()
    await m.ensureModel()
    m.send({ type: 'diarize_file', request_id: 'd1', path: 'x.wav' })
    const installing = m.installGpu()
    await vi.waitFor(() => expect(last().received.some((c) => c.type === 'install_gpu')).toBe(true))
    procs.gpuPack = true
    installed()
    await installing
    await new Promise((r) => setTimeout(r, 50))
    expect(all()).toHaveLength(1)
    all()[0].reply({ type: 'diarized', request_id: 'd1', segments: [] })
    await vi.waitFor(() => expect(all()).toHaveLength(2))
  })

  it('shares one install between the startup auto-install and the Settings button', async () => {
    const m = manager()
    await m.ensureModel()
    const a = m.installGpu()
    const b = m.installGpu()
    await vi.waitFor(() => expect(last().received.some((c) => c.type === 'install_gpu')).toBe(true))
    expect(all()[0].received.filter((c) => c.type === 'install_gpu')).toHaveLength(1)
    procs.gpuPack = true
    installed()
    await Promise.all([a, b])
  })
})

describe('replacing the sidecar for any reason', () => {
  it('loads the model on the new process even when the old one exits late', async () => {
    // The stop drain gives up on a stuck sidecar with shutdown(), and the transcript is then finished from the
    // audio on a new one. The old process takes up to two seconds to die, after the new one is already up.
    const m = manager()
    await m.ensureModel()
    m.shutdown()
    await m.ensureModel()
    expect(all()).toHaveLength(2)
    expect(all()[1].received.some((c) => c.type === 'load_model')).toBe(true)
    await vi.waitFor(() => expect(all()[0].killed).toBe(true))
    expect(m.modelInfo).not.toBeNull()
  })

  it('fails a request when the process it went to dies, even after it was replaced', async () => {
    const m = manager()
    await m.ensureStarted()
    const old = last()
    const waiting = m.request({ type: 'download_model', model_id: 'x', repo: 'r', models_dir: root }, 'model_downloaded', 60000)
    m.shutdown()
    await m.ensureStarted()
    old.kill()
    await expect(waiting).rejects.toThrow(/hætti óvænt/)
  })
})
