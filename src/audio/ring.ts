/**
 * The ring test.
 *
 * Barbershop chases one specific sound: the "expanded" chord, where the whole
 * thing blooms and you hear notes nobody in the room is singing. That is not
 * mysticism, it is arithmetic. When every part is a whole-number ratio of the
 * bass, all four voices put partials at *exactly* the same frequencies — on the
 * rungs of the bass's own harmonic series — and those partials add coherently.
 * Miss the ratio by a few cents and the same partials land a few hertz apart
 * instead, and two things a few hertz apart do not add: they beat.
 *
 * So this doesn't ask "is it in tune" in any general sense. It asks, rung by
 * rung up the harmonic series, whether the voices that ought to be sharing a
 * partial are reinforcing it or beating against it. That is what ringing *is*,
 * and it is why a broken rung can be reported with a rate in beats per second
 * instead of a vague score.
 *
 * Two decisions worth knowing about:
 *
 * Everything is measured against the bass *as actually sung*, never against
 * concert pitch. A chorus flat as a whole can ring perfectly, and telling them
 * otherwise would be answering a different question.
 *
 * Beat rates are derived from the measured fundamentals rather than from
 * watching each rung's level wobble. Watching the wobble is the obvious
 * approach and it fails on exactly the case that matters most: an equal
 * tempered seventh is about 31 cents out, which at 1.8kHz is 32Hz of beating,
 * and no analysis window short enough to see 32Hz is long enough to resolve the
 * partials in the first place. Deriving it assumes each voice's partials are
 * whole multiples of its own fundamental, which for a sustained sung note they
 * are.
 */

import { FFT, frameMagnitudes, hannWindow, refinePeak } from './fft'

export interface Recording {
  samples: Float32Array
  sampleRate: number
}

export interface RingTarget {
  part: string
  /**
   * The part's ideal ratio against the bass, as an exact fraction — 7/4 for a
   * barbershop seventh, 5/2 for the third an octave up.
   *
   * Exact rather than a decimal because the fraction *is* the answer to "which
   * partials do these two voices share": a part at a/b puts its b-th partial
   * on rung a, its 2b-th on rung 2a, and lands nowhere else. Approximating
   * with a tolerance instead lets a partial that merely passes near a rung be
   * counted as sitting on it, which reports beating between two voices that
   * were never trying to share anything.
   *
   * Always the just ratio, even when the pipe is sounding equal temperament:
   * the just ratio is what the chord is *for*, and measuring against it is how
   * an equal-tempered seventh gets to show up as the 31 cents it is.
   */
  num: number
  den: number
}

export interface RungReading {
  /** Which harmonic of the bass this is. */
  n: number
  freq: number
  /** Parts putting a partial here, and which partial of theirs it is. */
  parts: { part: string; partial: number }[]
  /** 0..1, how much of the recording's energy sits here. */
  energy: number
  /** 0..1. High means the partials here reinforced; low means they fought. */
  lock: number
  /** How fast this rung beats, in beats per second. 0 when it doesn't. */
  beatHz: number
}

export interface PartSummary {
  part: string
  /** Cents from where this part should sit relative to the bass as sung. */
  cents: number | null
  /** 0..1, how steadily the pitch was held. */
  steadiness: number
}

export interface Spectrogram {
  cols: number
  rows: number
  /** Row-major, 0..1, lowest frequency first. */
  data: Float32Array
  minHz: number
  maxHz: number
}

export interface RingReport {
  /** 0..100. */
  score: number
  rootHz: number
  rungs: RungReading[]
  parts: PartSummary[]
  /** Ring quality through the take, 0..1, for the trace under the score. */
  timeline: number[]
  spectrogram: Spectrogram
  duration: number
  /** Seconds into the recording where it rang best. */
  bestAt: number
  /** Set when there wasn't enough to analyse; nothing else is meaningful then. */
  problem?: string
}

/** Analysis block length. Long, because cents matter more here than timing. */
const BLOCK_SECONDS = 0.17
const BLOCK_HOP_SECONDS = 0.085
/** Highest harmonic of the bass worth looking at. */
const MAX_RUNG = 12
/**
 * Beat rate at which a shared partial is half-ruined.
 *
 * Set from what beating sounds like rather than from a tuning tolerance: a
 * couple of hertz is a slow shimmer that a chorus will hear as alive, six is
 * unmistakable wobble, and thirty is the roughness of a chord that refuses to
 * settle. Because it is in hertz and not cents, the same tuning error counts
 * for more the higher up the series it lands — which is exactly how it sounds.
 */
const HALF_LOCK_HZ = 6
/** How far either side of where a part should be we look for where it is. */
const SEARCH_CENTS = 100
/** Ignore rungs quieter than this fraction of the loudest. */
const QUIET_RUNG = 0.06
/** Blocks below this fraction of the take's peak are attack, release or gaps. */
const QUIET_BLOCK = 0.25

export function analyseRing(rec: Recording, targets: RingTarget[]): RingReport {
  const { samples, sampleRate } = rec
  const duration = samples.length / sampleRate
  const empty = emptyReport(duration)

  if (duration < 0.8) return { ...empty, problem: 'Too short to tell anything.' }
  if (targets.length < 2) {
    return { ...empty, problem: 'Pick a chord on the pipe — one voice cannot ring.' }
  }
  if (peakLevel(samples) < 0.01) {
    return { ...empty, problem: 'Too quiet. Sing closer to the microphone.' }
  }

  const size = pow2Near(sampleRate * BLOCK_SECONDS)
  if (samples.length < size * 2) {
    return { ...empty, problem: 'Too short to tell anything.' }
  }
  const hop = Math.max(128, Math.round(sampleRate * BLOCK_HOP_SECONDS))
  const fft = new FFT(size)
  const win = hannWindow(size)
  const bins = size >> 1
  const binHz = sampleRate / size
  const re = new Float32Array(size)
  const im = new Float32Array(size)
  const mags = new Float32Array(bins)

  const blockCount = Math.floor((samples.length - size) / hop) + 1
  const average = new Float32Array(bins)
  const blocks: {
    at: number
    level: number
    root: number
    cents: (number | null)[]
    score: number
  }[] = []

  for (let b = 0; b < blockCount; b++) {
    const offset = b * hop
    frameMagnitudes(samples, offset, win, fft, re, im, mags)
    for (let i = 0; i < bins; i++) average[i] += mags[i]

    const root = findRoot(mags, binHz)
    const cents = targets.map((t, ti) => {
      if (!root) return null
      const partial = cleanPartial(targets, ti)
      const expected = root * (t.num / t.den) * partial
      if (expected > (sampleRate / 2) * 0.9) return null
      const found = peakNear(mags, expected, binHz, SEARCH_CENTS)
      return found > 0 ? 1200 * Math.log2(found / expected) / partial : null
    })

    blocks.push({
      at: (offset + size / 2) / sampleRate,
      level: rms(samples, offset, size),
      root,
      cents,
      score: 0,
    })
  }
  for (let i = 0; i < bins; i++) average[i] /= blockCount

  const spectrogram = buildSpectrogram(samples, sampleRate)

  // Only blocks where the chord is actually sounding. The attack, the release
  // and any gap in the middle would otherwise be scored as failures to ring.
  const peak = Math.max(...blocks.map((b) => b.level))
  const usable = blocks.filter((b) => b.level > peak * QUIET_BLOCK && b.root > 0)
  if (usable.length < 2) {
    return { ...empty, spectrogram, problem: 'Could not hear a chord in that.' }
  }

  const rootHz = median(usable.map((b) => b.root))
  const energies = rungEnergies(average, binHz, rootHz, sampleRate)

  // --- per part ------------------------------------------------------------
  const parts: PartSummary[] = targets.map((t, ti) => {
    const vals = usable
      .map((b) => b.cents[ti])
      .filter((v): v is number => v !== null && Math.abs(v) < 150)
    if (vals.length < 2) return { part: t.part, cents: null, steadiness: 0 }
    const mid = median(vals)
    const spread = Math.sqrt(mean(vals.map((v) => (v - mid) ** 2)))
    return { part: t.part, cents: mid, steadiness: clamp01(1 - spread / 25) }
  })

  // --- the ladder ----------------------------------------------------------
  const rungs = buildRungs(
    rootHz,
    targets,
    parts.map((p) => p.cents),
    energies,
    sampleRate,
  )

  // --- score, per block then overall --------------------------------------
  for (const b of usable) {
    const theirs = buildRungs(b.root, targets, b.cents, energies, sampleRate)
    b.score = scoreRungs(theirs)
  }
  const timeline = usable.map((b) => b.score / 100)
  const score = Math.round(median(usable.map((b) => b.score)))

  let bestAt = usable[0].at
  let best = -1
  for (const b of usable) {
    if (b.score > best) {
      best = b.score
      bestAt = b.at
    }
  }

  return { score, rootHz, rungs, parts, timeline, spectrogram, duration, bestAt }
}

// ---------------------------------------------------------------------------

/**
 * One rung per harmonic of the bass, with whoever meets there.
 *
 * A part's k-th partial belongs to rung n when it is aiming at n × root. The
 * tolerance is generous on purpose: an equal-tempered seventh misses rung seven
 * by 31 cents, and excluding it would quietly drop the single most interesting
 * measurement in the whole style.
 */
function buildRungs(
  rootHz: number,
  targets: RingTarget[],
  cents: (number | null)[],
  energies: number[],
  sampleRate: number,
): RungReading[] {
  const rungs: RungReading[] = []
  const maxHz = Math.min(5200, (sampleRate / 2) * 0.9)

  for (let n = 1; n <= MAX_RUNG; n++) {
    const freq = n * rootHz
    if (freq > maxHz) break

    const here: { part: string; partial: number }[] = []
    const actual: number[] = []
    targets.forEach((t, ti) => {
      // A part at a/b in lowest terms puts its b-th partial on rung a, its
      // 2b-th on rung 2a, and touches no other rung at all.
      const [a, b] = reduce(t.num, t.den)
      if (n % a !== 0) return
      const partial = (n / a) * b
      if (partial > 12) return
      here.push({ part: t.part, partial })
      // Where that partial really landed, given how the part was actually sung.
      const off = cents[ti]
      actual.push(
        rootHz * (t.num / t.den) * partial * Math.pow(2, (off ?? 0) / 1200),
      )
    })

    // The widest disagreement on this rung is what you hear beating.
    let spread = 0
    for (let i = 0; i < actual.length; i++) {
      for (let j = i + 1; j < actual.length; j++) {
        spread = Math.max(spread, Math.abs(actual[i] - actual[j]))
      }
    }

    rungs.push({
      n,
      freq,
      parts: here,
      energy: energies[n - 1] ?? 0,
      lock: here.length >= 2 ? 1 / (1 + (spread / HALF_LOCK_HZ) ** 2) : 1,
      beatHz: here.length >= 2 ? spread : 0,
    })
  }
  return rungs
}

/**
 * One number for the whole ladder.
 *
 * Deliberately not an average. One partial beating hard is enough to stop a
 * chord ringing — that is the entire complaint — so the weakest rung carries
 * more than half the verdict, and the average only says how close the rest of
 * it came.
 */
function scoreRungs(rungs: RungReading[]): number {
  const scored = rungs.filter((r) => r.parts.length >= 2 && r.energy > QUIET_RUNG)
  if (!scored.length) return 0
  let num = 0
  let den = 0
  let worst = 1
  for (const r of scored) {
    num += r.energy * r.lock
    den += r.energy
    worst = Math.min(worst, r.lock)
  }
  const average = den > 0 ? num / den : 0
  return Math.round(100 * (0.45 * average + 0.55 * worst))
}

/** How much energy sits on each rung, normalised against the loudest. */
function rungEnergies(
  average: Float32Array,
  binHz: number,
  rootHz: number,
  sampleRate: number,
): number[] {
  const out: number[] = []
  const maxHz = Math.min(5200, (sampleRate / 2) * 0.9)
  for (let n = 1; n <= MAX_RUNG; n++) {
    const freq = n * rootHz
    if (freq > maxHz) {
      out.push(0)
      continue
    }
    // Half a rung either side, so neighbouring harmonics never share bins.
    const lo = Math.max(1, Math.floor((freq - rootHz * 0.42) / binHz))
    const hi = Math.min(average.length - 1, Math.ceil((freq + rootHz * 0.42) / binHz))
    let sum = 0
    for (let i = lo; i <= hi; i++) sum += average[i] * average[i]
    out.push(Math.sqrt(sum))
  }
  const loudest = Math.max(...out, 1e-9)
  return out.map((v) => clamp01(v / loudest))
}

/**
 * The bass, found rather than assumed.
 *
 * The lowest strong peak, not the loudest one: in a spread voicing the lead
 * singing the octave is frequently louder than the bass, and building the
 * ladder on the octave would silently halve every harmonic number in the
 * report.
 */
function findRoot(mags: Float32Array, binHz: number): number {
  const lo = Math.max(2, Math.floor(60 / binHz))
  const hi = Math.min(mags.length - 2, Math.floor(500 / binHz))
  if (hi <= lo) return 0
  let strongest = 0
  for (let i = lo; i <= hi; i++) strongest = Math.max(strongest, mags[i])
  if (strongest <= 0) return 0

  for (let i = lo; i <= hi; i++) {
    if (mags[i] < strongest * 0.25) continue
    if (mags[i] < mags[i - 1] || mags[i] < mags[i + 1]) continue
    return (i + refinePeak(mags, i)) * binHz
  }
  return 0
}

/**
 * The lowest partial of one target that no other target sits on.
 *
 * Same reason the live chord tuner does this: in these voicings the lead's
 * fundamental lands exactly on the bass's second harmonic, and reporting the
 * sum of two voices as one voice's pitch would be worse than saying nothing.
 */
function cleanPartial(targets: RingTarget[], index: number): number {
  const own = targets[index].num / targets[index].den
  for (let k = 1; k <= 4; k++) {
    const at = own * k
    let clash = false
    for (let j = 0; j < targets.length && !clash; j++) {
      if (j === index) continue
      for (let m = 1; m <= 4; m++) {
        if (Math.abs(1200 * Math.log2(((targets[j].num / targets[j].den) * m) / at)) < 45) {
          clash = true
          break
        }
      }
    }
    if (!clash) return k
  }
  return 1
}

/** Strongest bin within `cents` of `expected`, refined below bin spacing. */
function peakNear(
  mags: Float32Array,
  expected: number,
  binHz: number,
  cents: number,
): number {
  const lo = Math.max(1, Math.floor((expected * Math.pow(2, -cents / 1200)) / binHz))
  const hi = Math.min(
    mags.length - 2,
    Math.ceil((expected * Math.pow(2, cents / 1200)) / binHz),
  )
  if (hi <= lo) return 0
  let best = -1
  let bestVal = 0
  for (let i = lo; i <= hi; i++) {
    if (mags[i] > bestVal) {
      bestVal = mags[i]
      best = i
    }
  }
  if (best < 1) return 0
  return (best + refinePeak(mags, best)) * binHz
}

/**
 * A log-frequency picture of the take.
 *
 * Log rather than linear because the harmonic series is the thing being looked
 * at, and on a linear axis all of it is squashed into the bottom eighth.
 */
function buildSpectrogram(samples: Float32Array, sampleRate: number): Spectrogram {
  const size = pow2Near(sampleRate * 0.03)
  const rows = 96
  const cols = 200
  const minHz = 70
  const maxHz = 4200
  const data = new Float32Array(rows * cols)
  if (samples.length < size * 2) {
    return { cols: 0, rows: 0, data: new Float32Array(0), minHz, maxHz }
  }

  const fft = new FFT(size)
  const win = hannWindow(size)
  const bins = size >> 1
  const binHz = sampleRate / size
  const re = new Float32Array(size)
  const im = new Float32Array(size)
  const mags = new Float32Array(bins)
  const span = Math.log(maxHz / minHz)

  // Precompute which bins each row covers, rather than per column.
  const bands: [number, number][] = []
  for (let r = 0; r < rows; r++) {
    const f0 = minHz * Math.exp((r / rows) * span)
    const f1 = minHz * Math.exp(((r + 1) / rows) * span)
    const i0 = Math.max(1, Math.floor(f0 / binHz))
    bands.push([i0, Math.max(i0, Math.min(bins - 1, Math.ceil(f1 / binHz)))])
  }

  let loudest = 1e-9
  const step = Math.max(1, (samples.length - size) / cols)
  for (let c = 0; c < cols; c++) {
    frameMagnitudes(samples, Math.floor(c * step), win, fft, re, im, mags)
    for (let r = 0; r < rows; r++) {
      const [i0, i1] = bands[r]
      let v = 0
      for (let i = i0; i <= i1; i++) v = Math.max(v, mags[i])
      data[r * cols + c] = v
      loudest = Math.max(loudest, v)
    }
  }

  // To dB over a 55dB range — enough to show the harmonics without the noise
  // floor filling the picture with mud.
  for (let i = 0; i < data.length; i++) {
    data[i] = clamp01((20 * Math.log10(Math.max(data[i], 1e-9) / loudest) + 55) / 55)
  }
  return { cols, rows, data, minHz, maxHz }
}

// --- small helpers ---------------------------------------------------------

function emptyReport(duration: number): RingReport {
  return {
    score: 0,
    rootHz: 0,
    rungs: [],
    parts: [],
    timeline: [],
    spectrogram: { cols: 0, rows: 0, data: new Float32Array(0), minHz: 70, maxHz: 4200 },
    duration,
    bestAt: 0,
  }
}

function rms(v: Float32Array, offset: number, length: number): number {
  let sum = 0
  const end = Math.min(v.length, offset + length)
  for (let i = offset; i < end; i++) sum += v[i] * v[i]
  return Math.sqrt(sum / Math.max(1, end - offset))
}

function peakLevel(v: Float32Array): number {
  let peak = 0
  for (let i = 0; i < v.length; i++) peak = Math.max(peak, Math.abs(v[i]))
  return peak
}

function mean(v: ArrayLike<number>): number {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i]
  return v.length ? sum / v.length : 0
}

function median(v: number[]): number {
  if (!v.length) return 0
  const s = v.slice().sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Lowest terms, so a part's rungs come out of the fraction directly. */
function reduce(num: number, den: number): [number, number] {
  let a = Math.max(1, Math.round(num))
  let b = Math.max(1, Math.round(den))
  let x = a
  let y = b
  while (y) {
    const t = x % y
    x = y
    y = t
  }
  return [a / x, b / x]
}

/**
 * The simplest fraction close to a ratio, for a custom stack.
 *
 * A stack has no chord identity to look up, but two notes still share partials
 * whenever their ratio is near a simple fraction — that is all a chord is. The
 * denominator is capped low because a coincidence that only appears at the
 * nineteenth partial is not one anybody can hear.
 */
export function nearestRatio(x: number, maxDen = 9): [number, number] {
  let best: [number, number] = [1, 1]
  let bestErr = Infinity
  for (let d = 1; d <= maxDen; d++) {
    const n = Math.round(x * d)
    if (n < 1) continue
    const err = Math.abs(n / d - x)
    if (err < bestErr - 1e-12) {
      bestErr = err
      best = [n, d]
    }
  }
  return reduce(best[0], best[1])
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function pow2Near(n: number): number {
  let p = 256
  while (p * 2 <= n) p *= 2
  return p
}
