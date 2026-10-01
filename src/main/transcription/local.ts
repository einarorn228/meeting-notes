import { randomUUID } from 'node:crypto'
import { LOCAL_MODELS, type ChannelId } from '../../shared/types'
import { getSettings } from '../settings'
import { sidecar, type SidecarEvent } from './sidecar'
import type { EngineCallbacks, EngineStartOptions, TranscriptionEngine } from './types'

/** How many times the sidecar is restarted before the meeting is left to finish without live text. */
const REVIVE_ATTEMPTS = 5
const REVIVE_DELAY_MS = 3000
const REVIVE_SLOWEST_MS = 20000
/**
 * How long the sidecar may say nothing after stop before it counts as wedged. Not a limit on the backlog itself:
 * a large model on a CPU is slower than speech, so a long meeting ends with tens of minutes still queued, and a
 * flat ten-minute wait once saved a 45-minute meeting with 25 minutes of transcript.
 */
const STOP_IDLE_MS = 10 * 60 * 1000

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Local faster-whisper engine backed by the Python sidecar. */
export class LocalEngine implements TranscriptionEngine {
  readonly id = 'local'
  private sessionId = ''
  private cb: EngineCallbacks | null = null
  /** The status line shown once the model is loaded and the session is running. */
  private readyStatus = ''
  private listener: ((ev: SidecarEvent) => void) | null = null
  private exitListener: ((code: number | null) => void) | null = null
  private opts: EngineStartOptions | null = null
  private stopping = false
  /** True between the sidecar dying and it taking audio again; audio is dropped meanwhile. */
  private down = false
  private reviving: Promise<void> | null = null
  /** Set once any of the meeting's speech is known to have no text: audio dropped, or a backlog that never finished. */
  incomplete = false

  async start(opts: EngineStartOptions, cb: EngineCallbacks): Promise<void> {
    this.cb = cb
    this.incomplete = false
    cb.onStatus('Ræsi staðbundna talgreiningu…')
    await sidecar.ensureModel()
    const s = getSettings()
    const info = LOCAL_MODELS.find((m) => m.id === s.local.modelId) ?? LOCAL_MODELS[0]
    this.sessionId = randomUUID()
    this.listener = (ev) => {
      if (ev.session_id !== this.sessionId) return
      if (ev.type === 'segment') {
        const id = ev.seg_id ? String(ev.seg_id) : undefined
        // Close the placeholder first, and whether or not there is text: an empty segment means the cut held
        // nothing worth keeping, and leaving its placeholder up would show work that never finishes.
        if (id) cb.onPendingDone?.(id)
        const text = String(ev.text ?? '').trim()
        if (!text) return
        cb.onSegment({ id, channel: ev.channel as ChannelId, start: Number(ev.start), end: Number(ev.end), text, confidence: typeof ev.avg_logprob === 'number' ? Math.exp(ev.avg_logprob) : undefined })
      } else if (ev.type === 'pending') {
        // How far behind the transcript is gets shown as seconds next to the live text (see RecordingState's
        // transcriptLagSec). A count of waiting cuts said nothing useful: on a healthy machine a handful are
        // always in flight, so warning on the count alone cried wolf while text was only ~13 s behind speech.
        cb.onPending?.({ id: String(ev.seg_id), channel: ev.channel as ChannelId, start: Number(ev.start), end: Number(ev.end), queue: Number(ev.queue ?? 1) })
      } else if (ev.type === 'partial') {
        cb.onPartial(ev.channel as ChannelId, String(ev.text ?? ''), Number(ev.start))
      } else if (ev.type === 'finishing') {
        // Post-stop backlog. Reporting it is what separates "still working" from "hung" for the user.
        const pending = Number(ev.pending ?? 0)
        cb.onStatus(pending > 0 ? `Lýk við uppskrift… ${pending} bútar eftir` : 'Lýk við uppskrift…')
      } else if (ev.type === 'error') {
        cb.onError(String(ev.message), !!ev.fatal)
      }
    }
    sidecar.on('event', this.listener)
    // The process can die under us - most often killed by Windows when memory runs out with the meeting
    // software in the foreground. The recording itself does not depend on it, so the meeting carries on and
    // the session is started again on a fresh process instead of the rest of the meeting going untranscribed.
    this.exitListener = () => {
      if (this.stopping || !this.sessionId) return
      void this.revive()
    }
    sidecar.on('exit', this.exitListener)
    this.opts = opts
    this.stopping = false
    this.down = false
    this.sendStart(info.punctuated)
    const mi = sidecar.modelInfo
    this.readyStatus = `Staðbundin talgreining (${info.label.split(' – ')[0]}, ${mi?.device ?? 'cpu'})`
    cb.onStatus(this.readyStatus)
  }

  /** (Re)opens the streaming session on the sidecar. Timestamps stay absolute, so a restart leaves a gap. */
  private sendStart(punctuated: boolean): void {
    const opts = this.opts
    if (!opts) return
    sidecar.send({
      type: 'start',
      session_id: this.sessionId,
      language: opts.language === 'auto' ? null : opts.language,
      channels: opts.channels,
      vocabulary: opts.vocabulary,
      partials: opts.partials,
      punctuated
    })
  }

  /** Brings the sidecar back after it died mid-meeting, and says so plainly either way. */
  private async revive(): Promise<void> {
    if (this.reviving || this.down || this.stopping || !this.sessionId) return this.reviving ?? undefined
    const sessionId = this.sessionId
    this.down = true
    this.cb?.onError('Talgreiningin datt óvænt út. Upptakan heldur áfram og ég ræsi hana aftur.')
    this.reviving = (async () => {
      const info = LOCAL_MODELS.find((m) => m.id === getSettings().local.modelId) ?? LOCAL_MODELS[0]
      for (let attempt = 1; attempt <= REVIVE_ATTEMPTS; attempt++) {
        if (this.stopping || this.sessionId !== sessionId) return
        this.cb?.onStatus(`Ræsi talgreininguna aftur (tilraun ${attempt} af ${REVIVE_ATTEMPTS})…`)
        try {
          await sidecar.ensureModel()
          if (this.stopping || this.sessionId !== sessionId) return
          this.sendStart(info.punctuated)
          this.down = false
          // Clears the error line: the message it carried is over.
          this.cb?.onError('')
          this.cb?.onStatus(this.readyStatus)
          return
        } catch {
          await delay(Math.min(REVIVE_DELAY_MS * attempt, REVIVE_SLOWEST_MS))
        }
      }
      if (this.stopping || this.sessionId !== sessionId) return
      this.cb?.onError(
        'Talgreiningin fór ekki í gang aftur. Fundurinn er áfram tekinn upp og þú getur skrifað hann upp úr hljóðinu þegar honum lýkur.',
        true
      )
    })().finally(() => {
      this.reviving = null
    })
    return this.reviving
  }

  pushAudio(channel: ChannelId, pcm: Int16Array, tMs: number): void {
    if (!this.sessionId) return
    if (this.down) {
      this.incomplete = true
      return
    }
    try {
      sidecar.send({ type: 'audio', session_id: this.sessionId, channel, t_ms: tMs, pcm: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64') })
    } catch {
      this.incomplete = true
      // Audio arrives ten times a second: one notice about the outage, not one per frame.
      void this.revive()
    }
  }

  async stop(): Promise<void> {
    if (!this.sessionId) return
    this.stopping = true
    if (this.exitListener) sidecar.off('exit', this.exitListener)
    this.exitListener = null
    // A restart in flight must not re-open the session behind the stop.
    await this.reviving?.catch(() => {})
    if (this.down) {
      this.incomplete = true
      this.sessionId = ''
      if (this.listener) sidecar.off('event', this.listener)
      this.listener = null
      return
    }
    try {
      await this.drain(this.sessionId)
    } catch (e) {
      // The caller finishes the meeting from its audio; what is said here is why that became necessary.
      this.incomplete = true
      this.cb?.onError(`Uppskrift kláraðist ekki: ${e instanceof Error ? e.message : String(e)}. Hljóðið er til, svo fundurinn er skrifaður upp úr því.`)
    } finally {
      if (this.listener) sidecar.off('event', this.listener)
      this.listener = null
      this.sessionId = ''
    }
  }

  /**
   * Sends stop and waits for the backlog to be written out. The wait has no fixed length: every event of this
   * session (a finished line, the shrinking count) starts the clock again, so only a sidecar that has gone
   * silent for STOP_IDLE_MS is given up on - and that one is shut down, so it stops working on text nobody
   * will receive and the next request gets a fresh process.
   */
  private drain(sessionId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined
      const cleanup = (): void => {
        clearTimeout(timer)
        sidecar.off('event', onEvent)
        sidecar.off('exit', onExit)
      }
      const arm = (): void => {
        clearTimeout(timer)
        timer = setTimeout(() => {
          cleanup()
          sidecar.shutdown()
          reject(new Error(`talgreiningin svaraði engu í ${STOP_IDLE_MS / 60000} mínútur`))
        }, STOP_IDLE_MS)
      }
      const onEvent = (ev: SidecarEvent): void => {
        if (ev.session_id !== sessionId) return
        if (ev.type === 'stopped') {
          cleanup()
          resolve()
        } else if (ev.type === 'error' && ev.fatal) {
          cleanup()
          reject(new Error(String(ev.message)))
        } else arm()
      }
      const onExit = (code: number | null): void => {
        cleanup()
        reject(new Error(`talgreiningarferlið hætti óvænt (kóði ${code})`))
      }
      sidecar.on('event', onEvent)
      sidecar.on('exit', onExit)
      arm()
      try {
        sidecar.send({ type: 'stop', session_id: sessionId })
      } catch (e) {
        cleanup()
        reject(e)
      }
    })
  }

  async transcribeFile(path: string, opts: { language: string; vocabulary: string[]; stereo: boolean }, cb: EngineCallbacks): Promise<void> {
    await sidecar.ensureModel()
    const requestId = randomUUID()
    const listener = (ev: SidecarEvent): void => {
      if (ev.request_id !== requestId) return
      if (ev.type === 'segment') {
        const text = String(ev.text ?? '').trim()
        if (text) cb.onSegment({ channel: (ev.channel as ChannelId) ?? 'system', start: Number(ev.start), end: Number(ev.end), text })
      } else if (ev.type === 'status' && ev.message) {
        cb.onStatus(String(ev.message))
      }
    }
    sidecar.on('event', listener)
    try {
      await sidecar.request(
        { type: 'transcribe_file', request_id: requestId, path, language: opts.language === 'auto' ? null : opts.language, vocabulary: opts.vocabulary, channels_map: opts.stereo ? { '0': 'mic', '1': 'system' } : null },
        'file_done',
        6 * 3600 * 1000
      )
    } finally {
      sidecar.off('event', listener)
    }
  }
}
