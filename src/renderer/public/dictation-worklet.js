/*
 * Desktop dictation capture (app 2.5.0): the AudioWorklet that turns the
 * microphone into 16 kHz mono signed 16-bit PCM in 100 ms chunks (1600
 * frames, 3200 bytes) and posts each one, transferred, to its node's port.
 *
 * A static same-origin file (src/renderer/public, copied by Vite next to
 * index.html in out/renderer), so the production CSP `script-src 'self'`
 * covers it. When the AudioContext could not run at 16 kHz it runs at the
 * device rate and this worklet resamples by area averaging (a box filter,
 * enough low-pass for speech). Several input channels are mixed down.
 */
const TARGET_RATE = 16000
const CHUNK_FRAMES = 1600

class SnaosPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    // `sampleRate` is the AudioWorkletGlobalScope's context rate.
    this.ratio = sampleRate / TARGET_RATE
    this.buf = new Int16Array(CHUNK_FRAMES)
    this.len = 0
    this.acc = 0
    this.accW = 0
    this.need = this.ratio
  }

  push(v) {
    const s = v > 1 ? 1 : v < -1 ? -1 : v
    this.buf[this.len++] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff)
    if (this.len === CHUNK_FRAMES) {
      const out = this.buf.buffer
      this.port.postMessage(out, [out])
      this.buf = new Int16Array(CHUNK_FRAMES)
      this.len = 0
    }
  }

  process(inputs) {
    const chans = inputs[0]
    if (!chans || chans.length === 0 || !chans[0]) return true
    const frames = chans[0].length
    const n = chans.length
    for (let i = 0; i < frames; i++) {
      let x = chans[0][i]
      if (n > 1) {
        for (let c = 1; c < n; c++) x += chans[c][i]
        x /= n
      }
      if (this.ratio === 1) {
        this.push(x)
        continue
      }
      // Area average: each output sample is the mean of `ratio` input samples
      // (fractional edges weighted), so 48 kHz gives exactly 1 out of 3.
      let w = 1
      while (w > 1e-9) {
        const take = w < this.need ? w : this.need
        this.acc += x * take
        this.accW += take
        this.need -= take
        w -= take
        if (this.need <= 1e-9) {
          this.push(this.acc / this.accW)
          this.acc = 0
          this.accW = 0
          this.need += this.ratio
        }
      }
    }
    return true
  }
}

registerProcessor('snaos-pcm', SnaosPcmProcessor)
