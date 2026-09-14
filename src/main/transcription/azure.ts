/**
 * Azure AI Speech real-time engine (is-IS supported, with real-time diarization via ConversationTranscriber).
 * One recognizer per channel keeps the mic/system attribution; the system channel optionally uses diarization so
 * remote participants get separate speaker ids (Guest-1, Guest-2, ...).
 */
import * as sdk from 'microsoft-cognitiveservices-speech-sdk'
import type { ChannelId } from '../../shared/types'
import { getSettings } from '../settings'
import type { EngineCallbacks, EngineStartOptions, TranscriptionEngine } from './types'
import { bcp47 } from './types'

interface ChannelRec {
  push: sdk.PushAudioInputStream
  recognizer: sdk.SpeechRecognizer | sdk.ConversationTranscriber
  fedMs: number
}

export class AzureEngine implements TranscriptionEngine {
  readonly id = 'azure'
  private recs = new Map<ChannelId, ChannelRec>()
  private cb: EngineCallbacks | null = null

  async start(opts: EngineStartOptions, cb: EngineCallbacks): Promise<void> {
    this.cb = cb
    const { key, region, diarization } = getSettings().azure
    if (!key || !region) throw new Error('Azure Speech lykil eða svæði vantar')
    const config = sdk.SpeechConfig.fromSubscription(key, region)
    config.speechRecognitionLanguage = bcp47(opts.language === 'auto' ? 'is' : opts.language)
    config.outputFormat = sdk.OutputFormat.Detailed
    config.setProfanity(sdk.ProfanityOption.Raw)
    for (const ch of opts.channels) {
      const format = sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1)
      const push = sdk.AudioInputStream.createPushStream(format)
      const audio = sdk.AudioConfig.fromStreamInput(push)
      const useDiarization = diarization && ch === 'system'
      let recognizer: sdk.SpeechRecognizer | sdk.ConversationTranscriber
      if (useDiarization) {
        const ct = new sdk.ConversationTranscriber(config, audio)
        ct.transcribing = (_s, e) => {
          if (e.result.text) cb.onPartial(ch, e.result.text, e.result.offset / 1e7)
        }
        ct.transcribed = (_s, e) => {
          if (e.result.reason === sdk.ResultReason.RecognizedSpeech && e.result.text) {
            const spk = e.result.speakerId && e.result.speakerId !== 'Unknown' ? `Þátttakandi ${e.result.speakerId.replace(/^Guest-?/i, '')}` : undefined
            cb.onSegment({ channel: ch, start: e.result.offset / 1e7, end: (e.result.offset + e.result.duration) / 1e7, text: e.result.text, speaker: spk })
          }
        }
        ct.canceled = (_s, e) => {
          if (e.reason === sdk.CancellationReason.Error) cb.onError(`Azure: ${e.errorDetails}`)
        }
        recognizer = ct
      } else {
        const rec = new sdk.SpeechRecognizer(config, audio)
        rec.recognizing = (_s, e) => {
          if (e.result.text) cb.onPartial(ch, e.result.text, e.result.offset / 1e7)
        }
        rec.recognized = (_s, e) => {
          if (e.result.reason === sdk.ResultReason.RecognizedSpeech && e.result.text) {
            cb.onSegment({ channel: ch, start: e.result.offset / 1e7, end: (e.result.offset + e.result.duration) / 1e7, text: e.result.text })
          }
        }
        rec.canceled = (_s, e) => {
          if (e.reason === sdk.CancellationReason.Error) cb.onError(`Azure: ${e.errorDetails}`)
        }
        recognizer = rec
      }
      if (opts.vocabulary.length) {
        const phrases = sdk.PhraseListGrammar.fromRecognizer(recognizer as sdk.Recognizer)
        for (const p of opts.vocabulary.slice(0, 500)) phrases.addPhrase(p)
      }
      this.recs.set(ch, { push, recognizer, fedMs: 0 })
      await new Promise<void>((resolve, reject) => {
        if (recognizer instanceof sdk.ConversationTranscriber) recognizer.startTranscribingAsync(resolve, (e) => reject(new Error(String(e))))
        else recognizer.startContinuousRecognitionAsync(resolve, (e) => reject(new Error(String(e))))
      })
    }
    cb.onStatus(`Azure AI Speech (${config.speechRecognitionLanguage}${diarization ? ', aðgreining ræðumanna' : ''})`)
  }

  pushAudio(channel: ChannelId, pcm: Int16Array, tMs: number): void {
    const r = this.recs.get(channel)
    if (!r) return
    // Keep the stream clock aligned with session time: fill gaps (pauses) with silence.
    if (tMs > r.fedMs + 150) {
      const gapSamples = Math.round(((tMs - r.fedMs) / 1000) * 16000)
      r.push.write(new ArrayBuffer(gapSamples * 2))
      r.fedMs = tMs
    }
    const buf = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer
    r.push.write(buf)
    r.fedMs += (pcm.length / 16000) * 1000
  }

  async stop(): Promise<void> {
    const all = [...this.recs.values()]
    this.recs.clear()
    await Promise.all(
      all.map(
        (r) =>
          new Promise<void>((resolve) => {
            r.push.close()
            const done = (): void => {
              r.recognizer.close()
              resolve()
            }
            if (r.recognizer instanceof sdk.ConversationTranscriber) r.recognizer.stopTranscribingAsync(done, done)
            else r.recognizer.stopContinuousRecognitionAsync(done, done)
            setTimeout(done, 15000)
          })
      )
    )
  }
}

export async function testAzure(): Promise<{ ok: boolean; message: string }> {
  const { key, region } = getSettings().azure
  if (!key || !region) return { ok: false, message: 'Lykil eða svæði vantar' }
  const res = await fetch(`https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': key } })
  return res.ok ? { ok: true, message: `Tenging við Azure Speech (${region}) virkar` } : { ok: false, message: `Azure svaraði ${res.status}` }
}
