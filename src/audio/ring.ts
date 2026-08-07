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

import { FFT, frameMagnitudes, hannWindow } from './fft'
import { alignChord, measureChord, planChord } from './chord'
import { NoiseFloor, clamp01, type Spectrum } from './spectrum'

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
  /** How many of those parts were actually audible enough to be measured. */
  heard: number
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

export interface RingReport {
  /** 0..100. */
  score: number
  rootHz: number
  rungs: RungReading[]
  parts: PartSummary[]
  duration: number
  /** Set when there wasn't enough to analyse; nothing else is meaningful then. */
  problem?: string
}

/**
 * Analysis block length, in seconds.
 *
 * Long. Cents matter more than timing here, and the two trade directly: at a
 * tenth of a second the bins are twelve hertz apart, which is a hundred and
 * fifty cents at the bottom of a bass's range, and no amount of interpolation
 * recovers single-figure accuracy from that. A third of a second is still short
 * enough that a held chord gives twenty or more readings to take a median over.
 */
const BLOCK_SECONDS = 0.34
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
/** Ignore rungs quieter than this fraction of the loudest. */
const QUIET_RUNG = 0.06
/**
 * ...and a rung has to be at least this loud, relative to the loudest one, to
 * be allowed to set the verdict on its own.
 *
 * A twelfth harmonic thirty decibels down beats just as measurably as a second
 * one and is inaudible while doing it. Letting it decide marks down chords that
 * unmistakably rang, which is one of the two reasons the answer used to be no
 * whatever anyone sang.
 */
const AUDIBLE_RUNG = 0.12
/** Blocks below this fraction of the take's peak are attack, release or gaps. */
const QUIET_BLOCK = 0.25
/** Below this there is no chord in the block, whatever its level says. */
const MIN_CONFIDENCE = 0.16

/**
 * @param expectedRootHz Where the pipe put the bass.
 *
 * Not where the bass is assumed to be — where the search starts. Finding the
 * root by picking the lowest strong peak in the recording is the obvious
 * approach and it is what this used to do; it fails on a phone in a hall,
 * where the two loudest things below 200Hz are usually a handling thump and an
 * air conditioner, and a root that is wrong by an octave or a fifth makes every
 * rung in the report wrong and the whole chord read as though it never locked.
 * The pipe gave out the pitch a moment ago and knows exactly what it was, so
 * the search is seeded with it and the whole chord's shape is used to confirm
 * it — four overlapping harmonic series in a known arrangement being a great
 * deal of evidence about one unknown number.
 */
export function analyseRing(
  rec: Recording,
  targets: RingTarget[],
  expectedRootHz: number,
): RingReport {
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
  if (!(expectedRootHz > 0)) {
    return { ...empty, problem: 'Nothing to listen for.' }
  }

  const size = pow2Round(sampleRate * BLOCK_SECONDS)
  if (samples.length < size + 1) {
    return { ...empty, problem: 'Too short to tell anything.' }
  }
  const hop = Math.max(256, Math.round(sampleRate * BLOCK_HOP_SECONDS))
  const fft = new FFT(size)
  const win = hannWindow(size)
  const bins = size >> 1
  const binHz = sampleRate / size
  const re = new Float32Array(size)
  const im = new Float32Array(size)
  const mags = new Float32Array(bins)

  // Where each part would sit if the chord were sung exactly where the pipe
  // put it. Everything is measured as a departure from this shape, never from
  // these frequencies — a quartet a semitone flat is singing the same chord.
  const ideal = targets.map((t) => expectedRootHz * (t.num / t.den))
  const plans = planChord(ideal)
  const usableBins = Math.min(bins, Math.ceil(6000 / binHz))
  const spec: Spectrum = { mag: mags.subarray(0, usableBins), binHz }
  const floor = new NoiseFloor(55, Math.min(6000, sampleRate / 2.2))
  const scratch: number[] = []

  const blockCount = Math.floor((samples.length - size) / hop) + 1
  const average = new Float32Array(bins)
  const blocks: {
    at: number
    level: number
    /** Cents each part sits from its place in the chord, against the bass. */
    cents: (number | null)[]
    /** The bass as actually sung, in Hz. */
    root: number
    confidence: number
    score: number
  }[] = []

  let previous: number | null = null
  for (let b = 0; b < blockCount; b++) {
    const offset = b * hop
    frameMagnitudes(samples, offset, win, fft, re, im, mags)
    for (let i = 0; i < bins; i++) average[i] += mags[i]

    floor.measure(spec, scratch)
    const alignment = alignChord(spec, ideal, floor, previous)
    const m = measureChord(spec, ideal, plans, floor, alignment)
    if (alignment.confidence > MIN_CONFIDENCE) previous = m.offset

    // Everything against the bass as actually sung. A chorus flat as a whole
    // rings perfectly well, and telling them otherwise answers a question
    // nobody asked; only disagreeing with each other costs anything. When the
    // bass cannot be heard at all the chord's own centre stands in, which is
    // the same idea with a less authoritative reference.
    const bass = m.parts[0].cents
    const reference = bass ?? 0
    blocks.push({
      at: (offset + size / 2) / sampleRate,
      level: rms(samples, offset, size),
      cents: m.parts.map((p) => (p.cents === null ? null : p.cents - reference)),
      root: ideal[0] * Math.pow(2, (m.offset + reference) / 1200),
      confidence: m.confidence,
      score: 0,
    })
  }
  for (let i = 0; i < bins; i++) average[i] /= blockCount

  // Only blocks where the chord is actually sounding. The attack, the release
  // and any gap in the middle would otherwise be scored as failures to ring.
  const peak = Math.max(...blocks.map((b) => b.level))
  const usable = blocks.filter(
    (b) => b.level > peak * QUIET_BLOCK && b.confidence > MIN_CONFIDENCE,
  )
  if (usable.length < 2) {
    return { ...empty, problem: 'Could not hear a chord in that.' }
  }

  const rootHz = median(usable.map((b) => b.root))
  const energies = rungEnergies(average, binHz, rootHz, sampleRate)

  // --- per part ------------------------------------------------------------
  const parts: PartSummary[] = targets.map((t, ti) => {
    const vals = usable
      .map((b) => b.cents[ti])
      .filter((v): v is number => v !== null && Math.abs(v) < 150)
    // Heard in a couple of blocks out of a whole take is a consonant or a
    // neighbour bleeding through, not a part.
    if (vals.length < Math.max(2, usable.length * 0.35)) {
      return { part: t.part, cents: null, steadiness: 0 }
    }
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
    b.score = scoreRungs(buildRungs(b.root, targets, b.cents, energies, sampleRate))
  }
  const score = Math.round(median(usable.map((b) => b.score)))

  return { score, rootHz, rungs, parts, duration }
}

// ---------------------------------------------------------------------------

/**
 * One rung per harmonic of the bass, with whoever meets there.
 *
 * A part's k-th partial belongs to rung n when it is aiming at n × root. The
 * tolerance is generous on purpose: an equal-tempered seventh misses rung seven
 * by 31 cents, and excluding it would quietly drop the single most interesting
 * measurement in the whole style.
 *
 * A part nobody could hear is left off its rungs rather than entered at zero.
 * Entering it at zero says the silent part is exactly in tune, which turns
 * every rung it belongs to into evidence of a lock that was never sung.
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
      const off = cents[ti]
      if (off === null) return
      // Where that partial really landed, given how the part was actually sung.
      // The whole series moves together, so a voice ten cents sharp puts its
      // fourth partial ten cents sharp too — the offset is not divided down.
      actual.push(rootHz * (t.num / t.den) * partial * Math.pow(2, off / 1200))
    })

    // The widest disagreement on this rung is what you hear beating.
    let spread = 0
    for (let i = 0; i < actual.length; i++) {
      for (let j = i + 1; j < actual.length; j++) {
        spread = Math.max(spread, Math.abs(actual[i] - actual[j]))
      }
    }

    const measured = actual.length >= 2
    rungs.push({
      n,
      freq,
      parts: here,
      heard: actual.length,
      energy: energies[n - 1] ?? 0,
      lock: measured ? 1 / (1 + (spread / HALF_LOCK_HZ) ** 2) : 1,
      beatHz: measured ? spread : 0,
    })
  }
  return rungs
}

/**
 * One number for the whole ladder.
 *
 * Deliberately not an average. One partial beating hard is enough to stop a
 * chord ringing — that is the entire complaint — so the weakest rung carries
 * more than the rest of them put together, and the average only says how close
 * the rest of it came.
 *
 * "Weakest" is taken among rungs loud enough to be heard, though, which is the
 * correction that matters. A twelfth harmonic thirty decibels down beats just
 * as measurably as a second one and is inaudible while doing it, so letting it
 * set the verdict marks down chords that unmistakably rang — which is what
 * happened, and why the answer was always no.
 */
function scoreRungs(rungs: RungReading[]): number {
  const scored = rungs.filter((r) => r.heard >= 2 && r.energy > QUIET_RUNG)
  if (!scored.length) return 0

  let num = 0
  let den = 0
  let loudest = 0
  for (const r of scored) {
    num += r.energy * r.lock
    den += r.energy
    loudest = Math.max(loudest, r.energy)
  }
  const average = den > 0 ? num / den : 0

  // The worst rung anybody can actually hear. Taken in its own pass and against
  // a fixed threshold, because deciding it as the loop goes — against whatever
  // the worst rung so far happened to weigh — makes the verdict depend on the
  // order the rungs are visited in, and quietly skipped the beating one.
  let worst = 1
  for (const r of scored) {
    if (r.energy >= loudest * AUDIBLE_RUNG) worst = Math.min(worst, r.lock)
  }
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
 * A log-frequency picture of the take.
 *
 * Log rather than linear because the harmonic series is the thing being looked
 * at, and on a linear axis all of it is squashed into the bottom eighth.
 */

// --- small helpers ---------------------------------------------------------

function emptyReport(duration: number): RingReport {
  return {
    score: 0,
    rootHz: 0,
    rungs: [],
    parts: [],
    duration,
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

/** The power of two at or below `n`, for a window that must not overrun. */

/**
 * The *nearest* power of two, for a window sized by the resolution it needs
 * rather than by a length it must fit inside. Rounding down instead — which is
 * what happened here — halves the window and doubles the bin width, and the
 * comment above it goes on claiming a resolution the code stopped providing.
 */
function pow2Round(n: number): number {
  let p = 512
  while (p * 2 <= n * 1.4) p *= 2
  return Math.min(32768, p)
}
