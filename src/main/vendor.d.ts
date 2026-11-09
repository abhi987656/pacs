// Minimal typings for untyped runtime modules used by the main process.

declare module 'sherpa-onnx-node' {
  export interface SpeechSegment {
    start: number
    samples: Float32Array
  }
  export class Vad {
    constructor(config: Record<string, unknown>, bufferSizeInSeconds: number)
    acceptWaveform(samples: Float32Array): void
    isEmpty(): boolean
    isDetected(): boolean
    front(enableExternalBuffer?: boolean): SpeechSegment
    pop(): void
    flush(): void
    reset(): void
    clear(): void
  }
  export interface OfflineStream {
    acceptWaveform(obj: { sampleRate: number; samples: Float32Array }): void
  }
  export class OfflineRecognizer {
    static createAsync(config: Record<string, unknown>): Promise<OfflineRecognizer>
    createStream(): OfflineStream
    decodeAsync(stream: OfflineStream): Promise<{ text: string }>
  }
}

declare module 'unbzip2-stream' {
  import type { Duplex } from 'node:stream'
  export default function bz2(): Duplex
}

declare module 'tar-stream' {
  import type { Readable, Writable } from 'node:stream'
  export interface Headers {
    name: string
    size?: number
    type?: string
  }
  // Emits 'entry' (header: Headers, stream: Readable, next: () => void).
  export type Extract = Writable
  export type EntryStream = Readable
  export function extract(): Extract
}

declare module 'hyperdht' {
  const DHT: any // eslint-disable-line @typescript-eslint/no-explicit-any
  export default DHT
}
