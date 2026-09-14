/**
 * Manages the Python speech-to-text sidecar (faster-whisper). Handles: locating a runtime (bundled PyInstaller
 * binary or a managed virtualenv created from the user's Python), installing dependencies, spawning the process,
 * and the JSON-lines protocol (see sidecar/PROTOCOL.md).
 */
import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams, execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { EventEmitter } from 'node:events'
import { LOCAL_MODELS, type SidecarStatus } from '../../shared/types'
import { getSettings } from '../settings'

export interface SidecarEvent {
  type: string
  [k: string]: unknown
}

function isDev(): boolean {
  return !app.isPackaged
}

export function sidecarSourceDir(): string {
  // dev: <repo>/sidecar ; packaged: <resources>/sidecar
  return isDev() ? join(app.getAppPath(), 'sidecar') : join(process.resourcesPath, 'sidecar')
}

export function modelsDir(): string {
  const d = join(app.getPath('userData'), 'models')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

function venvDir(): string {
  return join(app.getPath('userData'), 'sidecar-venv')
}

function venvPython(): string {
  return process.platform === 'win32' ? join(venvDir(), 'Scripts', 'python.exe') : join(venvDir(), 'bin', 'python')
}

function bundledBinary(): string | null {
  const name = process.platform === 'win32' ? 'fundarritari-stt.exe' : 'fundarritari-stt'
  const os = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'
  const candidates = [
    join(process.resourcesPath ?? '', 'bin', os, 'fundarritari-stt', name),
    join(process.resourcesPath ?? '', 'bin', 'fundarritari-stt', name),
    join(process.resourcesPath ?? '', 'bin', name)
  ]
  for (const c of candidates) if (c && existsSync(c)) return c
  return null
}

function run(cmd: string, args: string[], opts: { cwd?: string; onLine?: (l: string) => void } = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PIP_DISABLE_PIP_VERSION_CHECK: '1' } })
    let out = ''
    const rl = createInterface({ input: child.stdout })
    rl.on('line', (l) => {
      out += l + '\n'
      opts.onLine?.(l)
    })
    const rle = createInterface({ input: child.stderr })
    rle.on('line', (l) => {
      out += l + '\n'
      opts.onLine?.(l)
    })
    child.on('error', (e) => resolve({ code: -1, out: out + String(e) }))
    child.on('close', (code) => resolve({ code: code ?? -1, out }))
  })
}

async function pythonVersion(cmd: string, args: string[] = []): Promise<[number, number] | null> {
  const res = await run(cmd, [...args, '-c', 'import sys;print(sys.version_info[0],sys.version_info[1])']).catch(() => null)
  if (!res || res.code !== 0) return null
  const m = res.out.trim().match(/(\d+)\s+(\d+)/)
  return m ? [Number(m[1]), Number(m[2])] : null
}

/** Finds a usable system Python (>= 3.10). Returns command + prefix args. */
export async function findSystemPython(): Promise<{ cmd: string; args: string[] } | null> {
  const s = getSettings()
  const candidates: { cmd: string; args: string[] }[] = []
  if (s.local.pythonPath) candidates.push({ cmd: s.local.pythonPath, args: [] })
  if (process.platform === 'win32') {
    candidates.push({ cmd: 'py', args: ['-3'] }, { cmd: 'python', args: [] }, { cmd: 'python3', args: [] })
  } else {
    candidates.push({ cmd: 'python3', args: [] }, { cmd: 'python', args: [] }, { cmd: '/usr/bin/python3', args: [] }, { cmd: '/opt/homebrew/bin/python3', args: [] }, { cmd: '/usr/local/bin/python3', args: [] })
  }
  for (const c of candidates) {
    const v = await pythonVersion(c.cmd, c.args)
    if (v && (v[0] > 3 || (v[0] === 3 && v[1] >= 10))) return c
  }
  return null
}

export class SidecarManager extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null
  private status: SidecarStatus = { state: 'not-installed' }
  private pendingHello: ((e: SidecarEvent) => void) | null = null
  private loadedModel: { modelId: string; requestedDevice: string; requestedComputeType: string; device: string; computeType: string } | null = null
  private starting: Promise<void> | null = null
  private loading: Promise<void> | null = null
  /** Last stderr lines, so a crash-on-startup reports *why* instead of a bare "sidecar exited". */
  private stderrTail: string[] = []

  private crashDetail(): string {
    const lines = this.stderrTail.filter((l) => l.trim()).slice(-6)
    return lines.length ? `\n\nSíðustu skilaboð frá talgreiningarferlinu:\n${lines.join('\n')}` : ''
  }

  getStatus(): SidecarStatus {
    return { ...this.status, installedModels: this.installedModels() }
  }

  private setStatus(patch: Partial<SidecarStatus>): void {
    this.status = { ...this.status, ...patch }
    this.emit('status', this.getStatus())
  }

  installedModels(): string[] {
    try {
      return readdirSync(modelsDir()).filter((d) => existsSync(join(modelsDir(), d, 'model.bin')))
    } catch {
      return []
    }
  }

  /** How the sidecar can be launched right now, if at all. */
  async runtime(): Promise<{ cmd: string; args: string[]; cwd?: string } | null> {
    const bin = bundledBinary()
    if (bin) return { cmd: bin, args: [] }
    const vp = venvPython()
    if (existsSync(vp)) {
      const v = await pythonVersion(vp)
      if (v) return { cmd: vp, args: ['-m', 'fundarritari_stt'], cwd: sidecarSourceDir() }
    }
    return null
  }

  async isInstalled(): Promise<boolean> {
    return (await this.runtime()) !== null
  }

  /** Creates the managed virtualenv and installs faster-whisper. Emits progress via status messages. */
  async install(): Promise<void> {
    if (bundledBinary()) return
    this.setStatus({ state: 'installing', message: 'Leita að Python…', progress: 0 })
    const py = await findSystemPython()
    if (!py) {
      this.setStatus({ state: 'error', message: 'Python 3.10+ fannst ekki. Settu upp Python frá python.org (hakaðu við "Add to PATH") og reyndu aftur.' })
      throw new Error('python-not-found')
    }
    this.setStatus({ state: 'installing', message: `Bý til Python umhverfi (${py.cmd})…`, progress: 0.05, pythonPath: py.cmd })
    let res = await run(py.cmd, [...py.args, '-m', 'venv', venvDir()])
    if (res.code !== 0) {
      this.setStatus({ state: 'error', message: 'Tókst ekki að búa til venv: ' + res.out.slice(-400) })
      throw new Error('venv-failed')
    }
    const vp = venvPython()
    await run(vp, ['-m', 'pip', 'install', '--upgrade', 'pip'])
    const req = join(sidecarSourceDir(), 'requirements.txt')
    this.setStatus({ state: 'installing', message: 'Sæki faster-whisper og CTranslate2 (getur tekið nokkrar mínútur)…', progress: 0.2 })
    let lines = 0
    res = await run(vp, ['-m', 'pip', 'install', '-r', req], {
      onLine: (l) => {
        lines++
        const m = l.match(/Collecting (\S+)|Downloading (\S+)|Installing collected/)
        if (m) this.setStatus({ state: 'installing', message: l.trim().slice(0, 120), progress: Math.min(0.9, 0.2 + lines * 0.01) })
      }
    })
    if (res.code !== 0) {
      this.setStatus({ state: 'error', message: 'pip install mistókst: ' + res.out.slice(-600) })
      throw new Error('pip-failed')
    }
    if (getSettings().local.device === 'cuda' && process.platform !== 'darwin') {
      this.setStatus({ state: 'installing', message: 'Sæki CUDA söfn (cuBLAS/cuDNN)…', progress: 0.92 })
      await run(vp, ['-m', 'pip', 'install', 'nvidia-cublas-cu12', 'nvidia-cudnn-cu12'])
    }
    this.setStatus({ state: 'idle', message: 'Uppsetningu lokið', progress: 1 })
  }

  /** Ensures the process is running and has replied to `hello`. */
  async ensureStarted(): Promise<void> {
    if (this.proc && !this.proc.killed) return
    if (this.starting) return this.starting
    this.starting = (async () => {
      const rt = await this.runtime()
      if (!rt) {
        this.setStatus({ state: 'not-installed', message: 'Staðbundin talgreining er ekki uppsett' })
        throw new Error('sidecar-not-installed')
      }
      const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', HF_HUB_DISABLE_TELEMETRY: '1' }
      this.stderrTail = []
      const proc = spawn(rt.cmd, rt.args, { cwd: rt.cwd ?? dirname(rt.cmd), env, windowsHide: true })
      this.proc = proc
      const rl = createInterface({ input: proc.stdout })
      rl.on('line', (line) => this.handleLine(line))
      const rle = createInterface({ input: proc.stderr })
      rle.on('line', (line) => {
        this.stderrTail.push(line)
        if (this.stderrTail.length > 40) this.stderrTail.shift()
        this.emit('log', line)
      })
      proc.on('exit', (code) => {
        this.emit('log', `sidecar exited with code ${code}`)
        this.proc = null
        this.loadedModel = null
        if (code) this.setStatus({ state: 'error', message: `Talgreiningarferlið hætti óvænt (kóði ${code}).${this.crashDetail()}` })
        else if (this.status.state !== 'error') this.setStatus({ state: 'idle', message: 'Talgreiningarferli lokaði' })
        this.emit('exit', code)
      })
      proc.on('error', (e) => {
        this.setStatus({ state: 'error', message: String(e) })
      })
      const hello = await this.request({ type: 'hello' }, 'ready', 60000)
      this.setStatus({ state: 'idle', message: `Tilbúið (faster-whisper ${hello.faster_whisper ?? ''}${hello.cuda ? ', CUDA' : ''})` })
    })()
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  private handleLine(line: string): void {
    let ev: SidecarEvent
    try {
      ev = JSON.parse(line)
    } catch {
      this.emit('log', line)
      return
    }
    if (ev.type === 'ready' && this.pendingHello) {
      const cb = this.pendingHello
      this.pendingHello = null
      cb(ev)
    }
    if (ev.type === 'status') {
      const st = ev.state as SidecarStatus['state']
      const friendly: Partial<Record<SidecarStatus['state'], string>> = {
        'loading-model': 'Hleð talgreiningarlíkani (tekur um hálfa mínútu)…',
        'downloading-model': 'Sæki talgreiningarlíkan…',
        ready: 'Talgreining tilbúin',
        idle: 'Talgreiningarþjónusta í gangi'
      }
      const message = st === 'error' ? String(ev.message ?? 'Villa') : (friendly[st] ?? (ev.message as string) ?? this.status.message)
      this.setStatus({ state: st, message, progress: ev.progress as number | undefined, modelId: (ev.model_id as string) ?? this.status.modelId, device: (ev.device as string) ?? this.status.device })
    }
    if (ev.type === 'progress') {
      this.setStatus({ state: 'downloading-model', progress: ev.progress as number, modelId: ev.model_id as string, message: `Sæki líkan ${(ev.downloaded_mb as number)?.toFixed?.(0) ?? ''} / ${(ev.total_mb as number)?.toFixed?.(0) ?? ''} MB` })
    }
    if (ev.type === 'error' && ev.fatal) {
      this.setStatus({ state: 'error', message: ev.message as string })
    }
    this.emit('event', ev)
  }

  send(cmd: Record<string, unknown>): void {
    if (!this.proc) throw new Error('sidecar not running')
    this.proc.stdin.write(JSON.stringify(cmd) + '\n')
  }

  /** Sends a command and waits for a reply event of `replyType` (or an `error` with the same request). */
  request(cmd: Record<string, unknown>, replyType: string, timeoutMs = 600000): Promise<SidecarEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`sidecar timeout waiting for ${replyType}`))
      }, timeoutMs)
      const onEvent = (ev: SidecarEvent): void => {
        const idMatch = cmd.request_id ? ev.request_id === cmd.request_id : cmd.model_id ? ev.model_id === cmd.model_id : true
        if (ev.type === replyType && idMatch) {
          cleanup()
          resolve(ev)
        } else if (ev.type === 'error' && (ev.fatal || (cmd.request_id && ev.request_id === cmd.request_id) || (!cmd.request_id && !ev.session_id))) {
          cleanup()
          reject(new Error(String(ev.message)))
        }
      }
      const onExit = (code: number | null): void => {
        cleanup()
        reject(new Error(`Talgreiningarferlið hætti óvænt (kóði ${code}).${this.crashDetail()}`))
      }
      const cleanup = (): void => {
        clearTimeout(timer)
        this.off('event', onEvent)
        this.off('exit', onExit)
      }
      this.on('event', onEvent)
      this.on('exit', onExit)
      if (cmd.type === 'hello') this.pendingHello = (ev) => onEvent(ev)
      try {
        this.send(cmd)
      } catch (e) {
        cleanup()
        reject(e)
      }
    })
  }

  async downloadModel(modelId: string): Promise<void> {
    const info = LOCAL_MODELS.find((m) => m.id === modelId)
    if (!info) throw new Error('unknown model ' + modelId)
    await this.ensureStarted()
    this.setStatus({ state: 'downloading-model', modelId, progress: 0, message: `Sæki ${info.label} (${(info.sizeMb / 1000).toFixed(1)} GB)…` })
    await this.request({ type: 'download_model', model_id: modelId, repo: info.repo, models_dir: modelsDir() }, 'model_downloaded', 6 * 3600 * 1000)
    this.setStatus({ state: 'idle', modelId, progress: 1, message: 'Líkan sótt' })
  }

  /** Loads the configured model if not already loaded (serialised so concurrent callers share one load). */
  async ensureModel(): Promise<void> {
    if (this.loading) return this.loading
    this.loading = this.ensureModelInner().finally(() => {
      this.loading = null
    })
    return this.loading
  }

  private async ensureModelInner(): Promise<void> {
    const s = getSettings()
    const modelId = s.local.modelId
    const info = LOCAL_MODELS.find((m) => m.id === modelId) ?? LOCAL_MODELS[0]
    await this.ensureStarted()
    // Pass the settings through verbatim: only the sidecar can see which compute types CTranslate2 actually
    // supports on this machine, and guessing here is what produced "float16 ... not supported" on a tester's PC.
    const device = s.local.device
    const computeType = s.local.computeType
    if (this.loadedModel && this.loadedModel.modelId === info.id && this.loadedModel.requestedDevice === device && this.loadedModel.requestedComputeType === computeType) return
    if (!this.installedModels().includes(info.id)) await this.downloadModel(info.id)
    this.setStatus({ state: 'loading-model', modelId: info.id, message: `Hleð líkani ${info.label}…`, progress: undefined })
    const ev = await this.request(
      { type: 'load_model', model_id: info.id, repo: info.repo, models_dir: modelsDir(), device, compute_type: computeType, threads: s.local.threads },
      'model_loaded',
      30 * 60 * 1000
    )
    // Keep both: the request decides whether a reload is needed, the resolved pair is what is shown.
    this.loadedModel = {
      modelId: info.id,
      requestedDevice: device,
      requestedComputeType: computeType,
      device: String(ev.device ?? device),
      computeType: String(ev.compute_type ?? computeType)
    }
    this.setStatus({ state: 'ready', modelId: info.id, device: this.loadedModel.device, message: `Líkan tilbúið (${this.loadedModel.device}, ${this.loadedModel.computeType})` })
  }

  get modelInfo(): { modelId: string; device: string } | null {
    return this.loadedModel
  }

  shutdown(): void {
    if (this.proc) {
      try {
        this.send({ type: 'shutdown' })
      } catch {
        /* ignore */
      }
      const p = this.proc
      setTimeout(() => {
        if (p && !p.killed) p.kill()
      }, 2000)
      this.proc = null
    }
  }
}

export const sidecar = new SidecarManager()

export function execFileAsync(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))))
  })
}
