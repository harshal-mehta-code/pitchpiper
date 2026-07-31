/**
 * A small radix-2 FFT.
 *
 * The live paths use AnalyserNode, which is fine when you want *a* spectrum
 * right now. Offline analysis wants things AnalyserNode cannot give: a chosen
 * window length, a chosen hop, and the ability to run over recorded samples
 * faster than real time. So this exists.
 */

export class FFT {
  readonly size: number
  private readonly cos: Float32Array
  private readonly sin: Float32Array
  private readonly rev: Uint32Array

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error('FFT size must be a power of two')
    }
    this.size = size
    const half = size >> 1
    this.cos = new Float32Array(half)
    this.sin = new Float32Array(half)
    for (let i = 0; i < half; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / size)
      this.sin[i] = Math.sin((-2 * Math.PI * i) / size)
    }

    // Bit-reversal permutation, precomputed once.
    const bits = Math.log2(size)
    this.rev = new Uint32Array(size)
    for (let i = 0; i < size; i++) {
      let r = 0
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
      this.rev[i] = r
    }
  }

  /** In-place complex transform. */
  transform(re: Float32Array, im: Float32Array) {
    const n = this.size
    for (let i = 0; i < n; i++) {
      const j = this.rev[i]
      if (j > i) {
        let t = re[i]
        re[i] = re[j]
        re[j] = t
        t = im[i]
        im[i] = im[j]
        im[j] = t
      }
    }

    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1
      const step = n / len
      for (let i = 0; i < n; i += len) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const c = this.cos[k]
          const s = this.sin[k]
          const a = i + j
          const b = a + half
          const tr = re[b] * c - im[b] * s
          const ti = re[b] * s + im[b] * c
          re[b] = re[a] - tr
          im[b] = im[a] - ti
          re[a] += tr
          im[a] += ti
        }
      }
    }
  }
}

/**
 * Hann window. Its sidelobes fall away fast, which is what matters when a
 * quiet partial sits a few bins from a loud one — and in a four-part chord it
 * always does.
 */
export function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)
  return w
}

/**
 * Magnitude spectrum of one windowed frame, written into `mags` (length n/2).
 * Zero-pads if the frame runs off the end of the signal.
 */
export function frameMagnitudes(
  signal: Float32Array,
  offset: number,
  window: Float32Array,
  fft: FFT,
  re: Float32Array,
  im: Float32Array,
  mags: Float32Array,
) {
  const n = fft.size
  for (let i = 0; i < n; i++) {
    const s = offset + i
    re[i] = s < signal.length && s >= 0 ? signal[s] * window[i] : 0
    im[i] = 0
  }
  fft.transform(re, im)
  for (let i = 0; i < mags.length; i++) {
    mags[i] = Math.hypot(re[i], im[i])
  }
}

/**
 * Where a spectral peak really is, in bins, by fitting a parabola through the
 * peak bin and its neighbours in the log domain. Returns a fractional offset.
 */
export function refinePeak(mags: Float32Array, i: number): number {
  if (i <= 0 || i >= mags.length - 1) return 0
  const a = Math.log(mags[i - 1] + 1e-12)
  const b = Math.log(mags[i] + 1e-12)
  const c = Math.log(mags[i + 1] + 1e-12)
  const denom = a - 2 * b + c
  if (denom === 0) return 0
  const d = (0.5 * (a - c)) / denom
  return Math.abs(d) < 1 ? d : 0
}
