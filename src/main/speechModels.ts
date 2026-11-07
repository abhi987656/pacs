import type { SpeechModelId } from '@shared/types'

// Offline speech-recognition models (run with sherpa-onnx, Apache-2.0).
// They are downloaded once from the sherpa-onnx GitHub releases and kept in <data>/speech/<id>.

const RELEASES = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/'

export const VAD_URL = `${RELEASES}silero_vad.onnx` // Silero VAD (MIT), 0.6 MB

export interface SpeechModelDef {
  id: SpeechModelId
  name: string
  description: string
  downloadMB: number
  url: string
  /** Files to keep from the archive (matched by file name). */
  keep: string[]
  kind: 'nemo-transducer' | 'whisper'
}

export const SPEECH_MODELS: SpeechModelDef[] = [
  {
    id: 'parakeet-v2',
    name: 'Parakeet TDT 0.6B v2 – English (recommended)',
    description:
      'NVIDIA Parakeet (CC-BY-4.0). Most accurate for medical dictation and still fast on a laptop CPU. Needs about 1.5 GB of free memory.',
    downloadMB: 460,
    url: `${RELEASES}sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2`,
    keep: ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'],
    kind: 'nemo-transducer'
  },
  {
    id: 'whisper-base',
    name: 'Whisper base – English (smaller)',
    description: 'OpenAI Whisper (MIT). Smaller and lighter, but makes more mistakes with medical words.',
    downloadMB: 200,
    url: `${RELEASES}sherpa-onnx-whisper-base.en.tar.bz2`,
    keep: ['base.en-encoder.int8.onnx', 'base.en-decoder.int8.onnx', 'base.en-tokens.txt'],
    kind: 'whisper'
  }
]

export function getSpeechModel(id: string): SpeechModelDef | undefined {
  return SPEECH_MODELS.find((m) => m.id === id)
}

/** sherpa-onnx OfflineRecognizer config for an installed model folder. */
export function recognizerConfig(m: SpeechModelDef, dir: string, numThreads: number): Record<string, unknown> {
  const p = (f: string) => `${dir}/${f}`
  if (m.kind === 'nemo-transducer') {
    return {
      featConfig: { sampleRate: 16000, featureDim: 128 },
      modelConfig: {
        transducer: { encoder: p('encoder.int8.onnx'), decoder: p('decoder.int8.onnx'), joiner: p('joiner.int8.onnx') },
        modelType: 'nemo_transducer',
        tokens: p('tokens.txt'),
        numThreads,
        provider: 'cpu',
        debug: 0
      }
    }
  }
  return {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      whisper: {
        encoder: p('base.en-encoder.int8.onnx'),
        decoder: p('base.en-decoder.int8.onnx'),
        language: 'en',
        task: 'transcribe',
        tailPaddings: -1
      },
      tokens: p('base.en-tokens.txt'),
      numThreads,
      provider: 'cpu',
      debug: 0
    }
  }
}
