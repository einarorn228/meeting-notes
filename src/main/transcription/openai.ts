import OpenAI, { toFile } from 'openai'
import type { ChannelId } from '../../shared/types'
import { getSettings } from '../settings'
import { ChunkedCloudEngine } from './chunked'

/** OpenAI transcription models (gpt-4o-transcribe / whisper-1) via the file API, chunked by our VAD. */
export class OpenAiEngine extends ChunkedCloudEngine {
  readonly id = 'openai'

  protected statusLabel(): string {
    return `OpenAI ${getSettings().openaiStt.model}`
  }

  protected async transcribeChunk(wav: Buffer, _channel: ChannelId): Promise<{ text: string }> {
    const { apiKey, model } = getSettings().openaiStt
    if (!apiKey) throw new Error('OpenAI API lykil vantar')
    const client = new OpenAI({ apiKey })
    const prompt = this.vocabulary.length ? this.vocabulary.join(', ') : undefined
    const res = await client.audio.transcriptions.create({
      file: await toFile(wav, 'chunk.wav', { type: 'audio/wav' }),
      model: model || 'gpt-4o-transcribe',
      language: this.language === 'auto' ? undefined : this.language,
      prompt,
      response_format: 'json'
    })
    return { text: (res as { text?: string }).text ?? '' }
  }
}

export async function testOpenAiStt(): Promise<{ ok: boolean; message: string }> {
  const { apiKey } = getSettings().openaiStt
  if (!apiKey) return { ok: false, message: 'API lykil vantar' }
  const client = new OpenAI({ apiKey })
  try {
    await client.models.list()
    return { ok: true, message: 'Tenging við OpenAI virkar' }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}
