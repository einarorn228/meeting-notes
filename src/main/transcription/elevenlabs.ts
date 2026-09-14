import type { ChannelId } from '../../shared/types'
import { getSettings } from '../settings'
import { ChunkedCloudEngine } from './chunked'
import { iso3 } from './types'

/** ElevenLabs Scribe v2 (Icelandic in the "excellent" accuracy tier) via the file API, chunked by our VAD. */
export class ElevenLabsEngine extends ChunkedCloudEngine {
  readonly id = 'elevenlabs'

  protected statusLabel(): string {
    return 'ElevenLabs Scribe v2'
  }

  protected async transcribeChunk(wav: Buffer, _channel: ChannelId): Promise<{ text: string }> {
    const { apiKey } = getSettings().elevenlabs
    if (!apiKey) throw new Error('ElevenLabs API lykil vantar')
    const form = new FormData()
    form.append('model_id', 'scribe_v2')
    if (this.language !== 'auto') form.append('language_code', iso3(this.language))
    form.append('tag_audio_events', 'false')
    form.append('diarize', 'false')
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'chunk.wav')
    const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': apiKey }, body: form })
    if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const json = (await res.json()) as { text?: string }
    return { text: json.text ?? '' }
  }
}

export async function testElevenLabs(): Promise<{ ok: boolean; message: string }> {
  const { apiKey } = getSettings().elevenlabs
  if (!apiKey) return { ok: false, message: 'API lykil vantar' }
  const res = await fetch('https://api.elevenlabs.io/v1/user', { headers: { 'xi-api-key': apiKey } })
  return res.ok ? { ok: true, message: 'Tenging við ElevenLabs virkar' } : { ok: false, message: `ElevenLabs svaraði ${res.status}` }
}
