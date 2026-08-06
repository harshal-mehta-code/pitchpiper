/**
 * Reading partials out of a magnitude spectrum.
 *
 * Both halves of the tuner ask the same three questions of a spectrum — where
 * is the background here, is there a partial at this frequency, and how much
 * of a harmonic series sits on this root — so they ask them in one place. The
 * live path fills a `Spectrum` from an AnalyserNode, the ring test fills one
 * from an offline FFT over recorded samples, and everything downstream of that
 * is shared.
 */

export interface Spectrum {
  /** Linear magnitude. Bin `i` is centred on `i * binHz`. */
  mag: Float32Array
  binHz: number
}

/** A partial, found. */
export interface Partial {
  freq: number
  mag: number
  /**
   * How far this stands above the background here, as a ratio. A partial only
   * means something relative to the noise around it: 30dB down from the loudest
   * thing in the room is enormous up at 3kHz and inaudible at 200Hz, because
   * the background is not flat and neither is a voice.
   */
  prominence: number
}

/**
 * The background, band by band.
 *
 * A single number for "the noise floor" is wrong by twenty decibels at one end
 * of the spectrum or the other: a sung vowel rolls off steeply, room noise
 * rises steeply the other way, and a threshold set from the average of the two
 * is met by nothing at the top and by everything at the bottom. So the floor is
 * a curve, taken as a low percentile within log-spaced bands — a percentile
 * rather than a minimum because one dead bin between two partials is not the
 * background, it is a null.
 */
export class NoiseFloor {
  private readonly edges: number[] = []
  private readonly level: Float32Array
  private readonly minHz: number
  private readonly maxHz: number

  constructor(minHz = 55, maxHz = 6000, bands = 28) {
    this.minHz = minHz
    this.maxHz = maxHz
    for (let i = 0; i <= bands; i++) {
      this.edges.push(minHz * Math.pow(maxHz / minHz, i / bands))
    }
    this.level = new Float32Array(bands)
  }

  /** Recompute from a spectrum. Cheap enough to run every analysis frame. */
  measure(spec: Spectrum, scratch: number[] = []) {
    for (let b = 0; b < this.level.length; b++) {
      const i0 = Math.max(1, Math.floor(this.edges[b] / spec.binHz))
      const i1 = Math.min(spec.mag.length - 1, Math.ceil(this.edges[b + 1] / spec.binHz))
      scratch.length = 0
      for (let i = i0; i <= i1; i++) scratch.push(spec.mag[i])
      if (!scratch.length) {
        this.level[b] = b > 0 ? this.level[b - 1] : 1e-7
        continue
      }
      scratch.sort(ascending)
      // A third of the way up. Above the nulls, well below any partial.
      this.level[b] = Math.max(scratch[Math.floor(scratch.length * 0.34)], 1e-9)
    }
  }

  at(freq: number): number {
    if (freq <= this.edges[0]) return this.level[0]
    const last = this.level.length - 1
    if (freq >= this.edges[last + 1]) return this.level[last]
    // Log position across the bands, then interpolate between band centres so
    // the floor is a curve rather than a staircase a partial can hide behind.
    const t =
      (Math.log(freq / this.minHz) / Math.log(this.maxHz / this.minHz)) *
      this.level.length
    const i = Math.max(0, Math.min(last, Math.floor(t - 0.5)))
    const j = Math.min(last, i + 1)
    const f = Math.max(0, Math.min(1, t - 0.5 - i))
    return this.level[i] * (1 - f) + this.level[j] * f
  }
}

/**
 * The strongest partial within `cents` of `freq`, or null.
 *
 * It has to be a local maximum, not merely the largest number in the window.
 * Without that rule the skirt of a loud partial half a semitone away is a
 * perfectly good answer, and the reading it produces is a confident measurement
 * of somebody else's voice.
 */
export function findPartial(
  spec: Spectrum,
  freq: number,
  cents: number,
  floor: NoiseFloor,
): Partial | null {
  const lo = Math.max(1, Math.floor((freq * Math.pow(2, -cents / 1200)) / spec.binHz))
  const hi = Math.min(
    spec.mag.length - 2,
    Math.ceil((freq * Math.pow(2, cents / 1200)) / spec.binHz),
  )
  if (hi <= lo) return null

  const mag = spec.mag
  let best = -1
  let bestVal = 0
  for (let i = lo; i <= hi; i++) {
    if (mag[i] <= bestVal) continue
    // Endpoints of the window can't be confirmed as peaks from inside it, so
    // they are allowed through only when the spectrum is still rising towards
    // them — a partial whose top sits just outside is not this part's.
    const rising = i === lo ? mag[i] > mag[i - 1] : mag[i] >= mag[i - 1]
    const falling = i === hi ? mag[i] > mag[i + 1] : mag[i] >= mag[i + 1]
    if (!rising || !falling) continue
    bestVal = mag[i]
    best = i
  }
  if (best < 1) return null

  const at = (best + parabolic(mag, best)) * spec.binHz
  return { freq: at, mag: bestVal, prominence: bestVal / floor.at(at) }
}

/**
 * How much of a harmonic series sits on `root`.
 *
 * Used to decide where a chord is before measuring anything in it. Magnitudes
 * are compressed on the way in, because otherwise one loud partial decides the
 * answer on its own and the whole point of looking at a series is that agreement
 * across it is the evidence.
 */
export function combSalience(
  spec: Spectrum,
  root: number,
  harmonics: number,
  floor: NoiseFloor,
  tolerance = 22,
): number {
  let sum = 0
  for (let h = 1; h <= harmonics; h++) {
    const f = root * h
    if (f > spec.mag.length * spec.binHz * 0.92) break
    const p = findPartial(spec, f, tolerance, floor)
    if (!p || p.prominence < 1.6) continue
    // 1/h: the upper partials of a voice are genuinely quieter, so they get a
    // vote proportional to how much they were ever going to contribute.
    sum += Math.sqrt(p.prominence) / h
  }
  return sum
}

/** Signed cents from `target` to `freq`. */
export function cents(freq: number, target: number): number {
  return 1200 * Math.log2(freq / target)
}

/**
 * Where the true peak sits relative to bin `i`, by fitting a parabola through
 * it and its neighbours in the log domain — which is where a windowed FFT's
 * peak is actually parabolic, and the reason this lands well inside a tenth of
 * a bin instead of merely inside one.
 */
export function parabolic(mag: Float32Array, i: number): number {
  if (i <= 0 || i >= mag.length - 1) return 0
  const a = Math.log(mag[i - 1] + 1e-12)
  const b = Math.log(mag[i] + 1e-12)
  const c = Math.log(mag[i + 1] + 1e-12)
  const denom = a - 2 * b + c
  if (denom === 0) return 0
  const d = (0.5 * (a - c)) / denom
  return Math.abs(d) < 1 ? d : 0
}

/** Median of `values`, which is sorted in place. */
export function median(values: number[]): number {
  if (!values.length) return 0
  values.sort(ascending)
  const mid = values.length >> 1
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2
}

/**
 * Weighted median.
 *
 * Every combination of readings in the tuner is a weighted median rather than a
 * weighted mean, and for one reason: a partial that has been captured by
 * another voice is not a slightly wrong reading, it is a completely wrong one,
 * and a mean lets it drag the answer in proportion to how wrong it is.
 */
export function weightedMedian(values: number[], weights: number[]): number {
  if (!values.length) return 0
  const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b])
  let total = 0
  for (const w of weights) total += w
  if (total <= 0) return median(values.slice())
  let seen = 0
  for (const i of order) {
    seen += weights[i]
    if (seen >= total / 2) return values[i]
  }
  return values[order[order.length - 1]]
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function ascending(a: number, b: number): number {
  return a - b
}
