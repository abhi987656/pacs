// AudioWorklet that forwards microphone audio (already resampled to the AudioContext rate,
// 16 kHz) to the page in ~100 ms chunks, together with a level value for the VU meter.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.size = 1600
    this.buf = new Float32Array(this.size)
    this.n = 0
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i]
      if (this.n === this.size) {
        let sum = 0
        for (let k = 0; k < this.size; k++) sum += this.buf[k] * this.buf[k]
        const chunk = this.buf
        this.port.postMessage({ samples: chunk, rms: Math.sqrt(sum / this.size) }, [chunk.buffer])
        this.buf = new Float32Array(this.size)
        this.n = 0
      }
    }
    return true
  }
}
registerProcessor('pcm-capture', PcmCapture)
