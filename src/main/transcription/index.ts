import type { EngineId } from '../../shared/types'
import { AzureEngine, testAzure } from './azure'
import { ElevenLabsEngine, testElevenLabs } from './elevenlabs'
import { LocalEngine } from './local'
import { OpenAiEngine, testOpenAiStt } from './openai'
import { sidecar } from './sidecar'
import type { TranscriptionEngine } from './types'

export function createEngine(id: EngineId): TranscriptionEngine {
  switch (id) {
    case 'azure':
      return new AzureEngine()
    case 'elevenlabs':
      return new ElevenLabsEngine()
    case 'openai':
      return new OpenAiEngine()
    case 'local':
    default:
      return new LocalEngine()
  }
}

export async function testEngine(id: string): Promise<{ ok: boolean; message: string }> {
  try {
    switch (id) {
      case 'azure':
        return await testAzure()
      case 'elevenlabs':
        return await testElevenLabs()
      case 'openai':
        return await testOpenAiStt()
      case 'local': {
        if (!(await sidecar.isInstalled())) return { ok: false, message: 'Staðbundin talgreining er ekki uppsett' }
        await sidecar.ensureModel()
        return { ok: true, message: sidecar.getStatus().message ?? 'Tilbúið' }
      }
      default:
        return { ok: false, message: 'Óþekkt vél' }
    }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}
