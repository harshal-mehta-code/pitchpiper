/**
 * Measuring four people singing a chord.
 *
 * The pipe knows what the chord is meant to be, which turns an unsolved problem
 * (blind four-part transcription) into a tractable one: look where each part
 * ought to be and measure how far off it is. That much was always the plan. The
 * trouble is the two words "ought to be".
 *
 * A chorus does not sing where the pipe put the chord. They sing where they
 * sang it — a semitone of collective drift over a verse is unremarkable, and
 * the pitch was given twenty seconds ago. Measured against absolute frequencies
 * that means every part reads as missing, and a chord that is locked to itself
 * perfectly reads as four singers who are all equally wrong. Nothing about that
 * is the question anyone asked. Being flat as a chorus is free; disagreeing with
 * each other is what costs.
 *
 * So this works in two passes. First find where the chord actually is, by
 * sliding the whole expected shape across the spectrum until its harmonics line
 * up with the ones that are there — the chord's *shape* is known exactly even
 * when its position is not, which is the entire leverage. Then measure each part
 * against that position, and report each one relative to the chord's own centre.
 * The collective offset is reported too, separately, because a director does
 * want to know the whole room has sagged — just not by being told all four
 * parts are broken.
 *
 * The second thing that goes wrong is barbershop voicings colliding with
 * themselves. The lead's octave sits exactly on the bass's second harmonic, and
 * the bari's fifth puts its own second harmonic on the bass's third; there is
 * frequently nowhere in the spectrum that belongs to one singer alone. Picking
 * the one clean harmonic and measuring there fails when there isn't one, and
 * picking a high harmonic to escape the collision trades a contaminated strong
 * partial for a clean partial too weak to find. So every part is measured at
 * every harmonic it has, each reading weighted by how much of it belongs to that
 * part, and combined with a weighted median — because a captured partial is not
 * a slightly wrong reading, it is somebody else's reading, and a median throws
 * it out where a mean would average it in.
 */

import {
  cents,
  clamp01,
  combSalience,
  findPartial,
  salienceAt,
  weightedMedian,
  type NoiseFloor,
  type Spectrum,
} from './spectrum'

/** Inside this, a part is locked in. Barbershop ears are better than this. */
export const IN_TUNE_CENTS = 6
/** Beyond this a part is not singing its note, it is singing a different one. */
export const CENTS_RANGE = 50

/** Harmonics of a part we are willing to measure at. */
const HARMONICS = 6
/** How far up another part's series we look when judging contamination. */
const FOREIGN_HARMONICS = 12
/** Two partials this close cannot be told apart by any peak picker. */
const COLLISION_CENTS = 40
/** ...and past this they no longer interfere at all. */
const CLEAR_CENTS = 75
/**
 * How far the whole chord is allowed to have drifted from the pipe, and how
 * finely that range is searched.
 *
 * Coarse then fine. The salience at each position is measured through a window
 * twenty-odd cents wide, so its peak is far too broad to be missed by a sweep
 * in twelve-cent steps — and refining only around the winner costs nine more
 * positions instead of the hundred and twenty a single fine sweep would need.
 * This runs thirty times a second on a phone that is also drawing smoke.
 */
const ALIGN_RANGE_CENTS = 240
const ALIGN_COARSE_CENTS = 12
const ALIGN_FINE_CENTS = 3
/** How far either side of an aligned target a part's partial may sit. */
const PART_SEARCH_CENTS = 55
/**
 * A partial has to stand this far above the local background to count.
 *
 * Between the partials of a chord the background is measured across a narrow
 * band of nothing much, so the tallest noise peak in one stands two or three
 * times clear of it as a matter of course. A bar set just above that lets a
 * part nobody is singing be assembled out of hiss — which is how a silent tenor
 * came to be reported, at a different pitch every frame.
 */
const MIN_PROMINENCE = 3.4
/**
 * ...and evidence is counted from how far past the bar a partial got, not from
 * having cleared it. A partial that only just qualifies contributes nothing,
 * which is the honest weight for something indistinguishable from the room.
 */
const PROMINENCE_SPAN = 2.5
/** Total evidence a part needs before it is reported as being in the room. */
const PRESENCE_FLOOR = 0.14
/**
 * Naming somebody as an octave out is a strong claim about a place we were not
 * even looking, so it takes strong evidence: a whole series present, and a
 * fundamental standing this far clear of the background. A voice's own
 * fundamental clears it by an order of magnitude; the low-frequency rumble a
 * phone picks up in a hall does not, and that rumble sits exactly an octave
 * below where a bass is singing.
 */
const OCTAVE_SALIENCE = 4
const OCTAVE_PROMINENCE = 6

// --- what to measure where --------------------------------------------------

export interface HarmonicPlan {
  h: number
  /** 0..1. How much of a partial at this point belongs to this part. */
  weight: number
  /**
   * True when no other part in the chord puts a partial here at all.
   *
   * Kept separate from `weight`, and decided structurally rather than by how
   * loud the intruder is likely to be, because the two answer different
   * questions. Combining readings is a question about amplitude — a partial
   * shared with somebody's weak twelfth harmonic is still mostly ours. Deciding
   * whether a part is in the room is not: a point shared with anybody is
   * evidence of nothing, because it sounds exactly the same when this part is
   * silent. Presence is only ever argued from a part's own points.
   */
  own: boolean
}

export interface PartPlan {
  harmonics: HarmonicPlan[]
  /**
   * True when this part has no point of its own anywhere — the octave doubling
   * above all, where every partial of the upper voice is also a partial of the
   * lower one. Readings are still taken, since the part is usually the loudest
   * thing at its own fundamental even when doubled, but the row says so rather
   * than presenting two voices added together as one singer's pitch.
   */
  shared: boolean
}

/**
 * Which harmonics of each part are worth measuring, and how much to trust each.
 *
 * Depends only on the chord's intervals, so it is computed when the chord
 * changes rather than thirty times a second.
 */
export function planChord(freqs: number[]): PartPlan[] {
  return freqs.map((base, i) => {
    const harmonics: HarmonicPlan[] = []
    let anyOwn = false
    for (let h = 1; h <= HARMONICS; h++) {
      const f = base * h
      let contamination = 0
      let collides = false
      for (let j = 0; j < freqs.length; j++) {
        if (j === i) continue
        for (let k = 1; k <= FOREIGN_HARMONICS; k++) {
          const overlap = Math.abs(cents(freqs[j] * k, f))
          if (overlap >= CLEAR_CENTS) continue
          if (overlap <= COLLISION_CENTS) collides = true
          const near =
            overlap <= COLLISION_CENTS
              ? 1
              : 1 - (overlap - COLLISION_CENTS) / (CLEAR_CENTS - COLLISION_CENTS)
          // Divided by k, because a voice's twelfth partial is thirty decibels
          // down and contaminates about that much less than its second.
          contamination += near / k
        }
      }
      if (!collides) anyOwn = true
      // 1/sqrt(h) on top: the lower harmonics of a voice carry far more energy,
      // so a slightly contaminated second partial beats a pristine sixth that
      // is barely above the room.
      harmonics.push({
        h,
        weight: 1 / (1 + contamination) / Math.sqrt(h),
        own: !collides,
      })
    }
    return { harmonics, shared: !anyOwn }
  })
}

// --- finding the chord ------------------------------------------------------

export interface Alignment {
  /** Cents the whole chord sits from where the pipe put it. */
  shift: number
  /** 0..1 that there is a chord here at all. */
  confidence: number
}

/**
 * Where the chord actually is.
 *
 * Slides the whole expected shape across the spectrum and takes the position
 * where its harmonics best coincide with real partials. Using every part at
 * once is what makes this hold up: a bass fundamental on a phone microphone is
 * often barely there, and any one part may be silent, but four overlapping
 * harmonic series in a known arrangement is a great deal of evidence about one
 * unknown number.
 */
export function alignChord(
  spec: Spectrum,
  freqs: number[],
  floor: NoiseFloor,
  previous: number | null,
): Alignment {
  let best = 0
  let bestScore = -1
  let total = 0
  let count = 0

  const at = (s: number): number => {
    const ratio = Math.pow(2, s / 1200)
    let score = 0
    for (const f of freqs) score += combSalience(spec, f * ratio, 5, floor)
    // A gentle preference for staying put. Two positions that fit the spectrum
    // equally well are not equally likely when one of them is where the chord
    // was a thirtieth of a second ago, and without this the readout hops
    // between them and calls it measurement.
    return previous === null
      ? score
      : score * (1 + 0.06 * Math.exp(-Math.abs(s - previous) / 45))
  }

  for (let s = -ALIGN_RANGE_CENTS; s <= ALIGN_RANGE_CENTS; s += ALIGN_COARSE_CENTS) {
    const score = at(s)
    // The average is taken over the coarse sweep alone, which covers the range
    // evenly. Folding the refinement into it would weight the neighbourhood of
    // the winner nine times over and flatter every result.
    total += score
    count++
    if (score > bestScore) {
      bestScore = score
      best = s
    }
  }

  const coarse = best
  for (
    let s = coarse - ALIGN_COARSE_CENTS + ALIGN_FINE_CENTS;
    s < coarse + ALIGN_COARSE_CENTS;
    s += ALIGN_FINE_CENTS
  ) {
    if (Math.abs(s) > ALIGN_RANGE_CENTS) continue
    const score = at(s)
    if (score > bestScore) {
      bestScore = score
      best = s
    }
  }

  // Against the average fit across the whole search, so "a chord is here" means
  // this position is better than the alternatives rather than merely non-zero.
  const average = count ? total / count : 0
  const confidence = average > 0 ? clamp01((bestScore / average - 1) / 1.6) : 0
  return { shift: best, confidence }
}

// --- measuring the parts ----------------------------------------------------

export interface MeasuredPart {
  /** Cents from this part's place in the chord, or null when not heard. */
  cents: number | null
  /** 0..1, how strongly this part is carrying. */
  strength: number
  /** Every partial of this part is shared with another voice. */
  shared: boolean
  /**
   * -1 or +1 when the part was found an octave from where it was expected,
   * which is worth saying out loud: "Tenor is an octave down" is a real thing
   * that happens in a rehearsal and reads as silence otherwise.
   */
  octave: number
}

export interface ChordMeasurement {
  parts: MeasuredPart[]
  /** Cents the chord as a whole sits from the pipe. */
  offset: number
  /** 0..1 that a chord is being sung at all. */
  confidence: number
}

/**
 * One frame: where each part sits relative to the chord's own centre.
 *
 * Note that a part's error in cents is the same at every harmonic — a voice ten
 * cents sharp puts its fourth partial ten cents sharp too, since the whole
 * series scales together. Measuring high up buys resolution, not a different
 * number, and dividing the reading down by the harmonic number (which is the
 * intuitive thing to do, and wrong) reports a quarter of the error.
 */
export function measureChord(
  spec: Spectrum,
  freqs: number[],
  plans: PartPlan[],
  floor: NoiseFloor,
  alignment: Alignment,
): ChordMeasurement {
  const ratio = Math.pow(2, alignment.shift / 1200)
  const maxHz = spec.mag.length * spec.binHz * 0.92

  const raw = freqs.map((base, i) => {
    const aligned = base * ratio
    const plan = plans[i]
    // A part with points of its own is judged only on those. A part with none —
    // the octave doubling — has to be argued from shared ground, and pays for
    // it with a stiffer bar and a flag on the row.
    const usable = plan.shared
      ? plan.harmonics
      : plan.harmonics.filter((p) => p.own)
    const bar = plan.shared ? MIN_PROMINENCE * 1.7 : MIN_PROMINENCE

    const values: number[] = []
    const weights: number[] = []
    let strength = 0

    for (const { h, weight } of usable) {
      const at = aligned * h
      if (at > maxHz) break
      const found = findPartial(spec, at, PART_SEARCH_CENTS, floor)
      if (!found || found.prominence < bar) continue
      const off = cents(found.freq, at)
      // Further out than this and it is a neighbour's partial wandering into
      // the window, not this part sung badly.
      if (Math.abs(off) > CENTS_RANGE) continue
      // Confidence in this one reading: how cleanly the point belongs to this
      // part, and how far the partial stands above the room.
      const w =
        weight * Math.min(1, Math.log2(found.prominence / MIN_PROMINENCE) / PROMINENCE_SPAN)
      values.push(off)
      weights.push(w)
      strength += w
    }

    if (!values.length || strength < PRESENCE_FLOOR) {
      return { off: null, strength: 0, octave: 0 }
    }
    return {
      off: weightedMedian(values, weights),
      strength: clamp01(strength / 1.4),
      octave: 0,
    }
  })

  // Someone singing their part an octave out. Worth naming: it reads as either
  // silence or perfect tuning otherwise, and "the tenor is an octave down" is a
  // thing that happens in a rehearsal and is fixed the moment it is said.
  //
  // The two directions need opposite tests, which is the whole subtlety. A part
  // sung an octave *up* simply vacates its own fundamental, so it is found by
  // being missing. A part sung an octave *down* does not go missing at all —
  // its second harmonic lands exactly on the note it was supposed to sing, so
  // it reads as present and perfectly in tune. What gives it away is the octave
  // below, where a chord in its proper voicing puts nothing whatsoever.
  freqs.forEach((base, i) => {
    const aligned = base * ratio
    // Only where nothing else in the chord could account for a partial. In a
    // close voicing the octave below a part is frequently another part.
    const clear = (at: number) =>
      at >= 55 &&
      at <= maxHz &&
      !freqs.some((f, j) => {
        if (j === i) return false
        for (let k = 1; k <= FOREIGN_HARMONICS; k++) {
          if (Math.abs(cents(f * ratio * k, at)) < 60) return true
        }
        return false
      })

    // A whole series, not one bump. Between the partials of a chord the local
    // background is measured across a narrow band of nothing, so an ordinary
    // noise peak stands well clear of it and reads as a confident partial.
    //
    // Which multiples get counted is the whole question. A voice singing an
    // octave low puts partials at f/2, 3f/2, 5f/2 and so on; a voice singing
    // the right note puts them at f, 2f, 3f. The two sets share every even
    // multiple of f/2 — so counting the series at f/2 wholesale asks a question
    // that answers itself the moment the part sings at all, which is exactly
    // what it did: three parts singing perfectly were each accused of being an
    // octave down. Only the odd multiples tell the two apart.
    // And a series means more than one rung of it. A room mode, an amplifier
    // buzz or a fridge sits on a single low frequency, and if that frequency
    // happens to be an octave under somebody it will carry any test that only
    // adds energy up — a hum is loud at f/2 and silent at 3f/2, which is
    // precisely how it differs from a person.
    const odd = [1, 3, 5].filter((m) => clear((aligned / 2) * m))
    const below = aligned / 2
    if (odd.includes(1) && odd.length >= 2) {
      // At the ordinary bar for a partial, not the permissive one salience
      // normally uses: counting rungs of a series is a question about whether
      // they are there, and between two partials an unremarkable noise peak
      // clears a permissive bar as a matter of course.
      const there = salienceAt(spec, below, odd, floor, 22, MIN_PROMINENCE)
      const found =
        there.salience >= OCTAVE_SALIENCE && there.present >= 2
          ? findPartial(spec, below, PART_SEARCH_CENTS, floor)
          : null
      if (found && found.prominence > OCTAVE_PROMINENCE) {
        raw[i] = {
          off: cents(found.freq, below),
          strength: clamp01(Math.log2(found.prominence) / 4),
          octave: -1,
        }
        return
      }
    }

    // Upwards is the opposite case and needs the opposite test. A part sung an
    // octave up has no partial of its own left at the note it was meant to
    // sing, so it is found by being missing from there — and then by a series
    // an octave above that nothing else in the chord accounts for.
    if (raw[i].off !== null) return
    const above = aligned * 2
    if (!clear(above)) return
    if (combSalience(spec, above, 4, floor) < OCTAVE_SALIENCE) return
    const found = findPartial(spec, above, PART_SEARCH_CENTS, floor)
    if (!found || found.prominence < OCTAVE_PROMINENCE) return
    raw[i] = {
      off: cents(found.freq, above),
      strength: clamp01(Math.log2(found.prominence) / 4),
      octave: 1,
    }
  })

  // The chord's own centre, from the parts that were actually heard. A median
  // so that one part half a semitone out moves itself rather than moving the
  // reference everyone else is judged against.
  const heard = raw.filter((r) => r.off !== null)
  const centre = heard.length
    ? weightedMedian(
        heard.map((r) => r.off as number),
        heard.map((r) => Math.max(0.05, r.strength)),
      )
    : 0

  return {
    parts: raw.map((r, i) => ({
      cents:
        r.off === null
          ? null
          : Math.max(-CENTS_RANGE, Math.min(CENTS_RANGE, r.off - centre)),
      strength: r.strength,
      shared: plans[i].shared,
      octave: r.octave,
    })),
    offset: alignment.shift + centre,
    confidence: alignment.confidence,
  }
}

// --- holding still ----------------------------------------------------------

export interface PartReading {
  cents: number | null
  strength: number
  shared: boolean
  octave: number
}

export interface ChordReading {
  parts: PartReading[]
  /** 0..1, how much of the chord is locked in. 1 is all of it. */
  lock: number
  /** True once the whole chord has been locked for long enough to mean it. */
  ringing: boolean
  /** Cents the chord as a whole sits from the pipe. */
  offset: number
  /** True when there is a chord to report on at all. */
  present: boolean
}

/** Rise and fall of the evidence that a part is there, per analysis frame. */
const PRESENCE_ATTACK = 0.4
const PRESENCE_RELEASE = 0.11
/** Hysteresis. A part appears at the top and disappears at the bottom. */
const PRESENT_ON = 0.45
const PRESENT_OFF = 0.18
/** How long the whole chord must hold before the panel says it rang. */
const RING_HOLD_MS = 260
const RING_RELEASE_MS = 420

/**
 * The part of this that stops the readout strobing.
 *
 * A frame of audio is a third of a second of evidence about people who are
 * breathing, moving and singing consonants, and any one of those frames can
 * fail to find a part that is plainly there. Deciding "heard" or "not heard"
 * frame by frame turns that into a row flickering thirty times a second, which
 * is not a measurement anyone can read and not a fault anyone can act on. So
 * evidence accumulates and decays instead: a part has to go genuinely missing
 * for a third of a second before it is reported missing, and the same rule
 * keeps the whole panel from blinking at the moment a chord locks.
 */
export class ChordTracker {
  private presence: number[] = []
  private held: boolean[] = []
  private smoothed: number[] = []
  private lockedAt = 0
  private lostAt = 0
  private ringing = false
  private offset = 0
  private shift: number | null = null

  /** The alignment from the last frame, so the search can prefer staying put. */
  get lastShift(): number | null {
    return this.shift
  }

  reset() {
    this.presence = []
    this.held = []
    this.smoothed = []
    this.ringing = false
    this.lockedAt = 0
    this.lostAt = 0
    this.offset = 0
    this.shift = null
  }

  update(m: ChordMeasurement, now: number): ChordReading {
    const n = m.parts.length
    if (this.presence.length !== n) {
      this.presence = new Array(n).fill(0)
      this.held = new Array(n).fill(false)
      this.smoothed = new Array(n).fill(0)
    }

    const present = m.confidence > 0.16
    if (present) this.shift = m.offset
    this.offset += (m.offset - this.offset) * (present ? 0.15 : 0.02)

    const parts: PartReading[] = m.parts.map((p, i) => {
      const seen = present && p.cents !== null
      const target = seen ? Math.min(1, 0.35 + p.strength) : 0
      const rate = seen ? PRESENCE_ATTACK : PRESENCE_RELEASE
      this.presence[i] += (target - this.presence[i]) * rate
      if (this.presence[i] > PRESENT_ON) this.held[i] = true
      else if (this.presence[i] < PRESENT_OFF) this.held[i] = false

      if (seen) {
        // Jumped rather than drifted: a leap of more than a semitone is a new
        // note or a new singer, and easing towards it would spend half a second
        // reading out frequencies nobody sang.
        this.smoothed[i] =
          Math.abs((p.cents as number) - this.smoothed[i]) > 35
            ? (p.cents as number)
            : this.smoothed[i] + ((p.cents as number) - this.smoothed[i]) * 0.3
      }

      return {
        cents: this.held[i] ? this.smoothed[i] : null,
        strength: clamp01(this.presence[i]),
        shared: p.shared,
        octave: p.octave,
      }
    })

    const audible = parts.filter((p) => p.cents !== null)
    const locked = audible.filter(
      (p) => Math.abs(p.cents as number) <= IN_TUNE_CENTS && !p.octave,
    )
    // Scaled by how much of the chord is actually there, so three parts locked
    // and one silent is three quarters of the way to ringing rather than all of
    // it — silence is not agreement.
    const lock = n ? (locked.length / n) * (audible.length / n) : 0

    const whole = n > 0 && audible.length === n && locked.length === n
    if (whole) {
      this.lostAt = 0
      if (!this.lockedAt) this.lockedAt = now
      if (now - this.lockedAt >= RING_HOLD_MS) this.ringing = true
    } else {
      this.lockedAt = 0
      if (!this.lostAt) this.lostAt = now
      if (now - this.lostAt >= RING_RELEASE_MS) this.ringing = false
    }

    return {
      parts,
      lock,
      ringing: this.ringing,
      offset: this.offset,
      present: audible.length > 0,
    }
  }
}
