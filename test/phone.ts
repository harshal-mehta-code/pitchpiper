/**
 * What a phone does to a chorus before the app ever sees it.
 *
 * The suspicion is a fair one and it is worth being precise about, because the
 * things a handset does to a signal are not gentle. In rough order of how much
 * they matter here:
 *
 * The microphone cannot hear a bass. A phone's acoustic port and its MEMS
 * capsule roll off steeply below a couple of hundred hertz, which is above the
 * fundamental of every bass note this instrument gives out — C3 is 131Hz, and a
 * bass singing G2 is 98Hz. Their fundamental arrives twenty or thirty decibels
 * down on their second harmonic, and any analysis that leans on it is leaning
 * on the quietest thing in the room.
 *
 * A rehearsal hall is reverberant. Reflections arriving milliseconds late comb
 * the spectrum, so the *level* of any given partial is unreliable in a way that
 * has nothing to do with how well it was sung.
 *
 * Forty singers at arm's length are loud, and a phone preamp saturates. Soft
 * clipping is a nonlinearity, and a nonlinearity applied to a harmonic series
 * generates sum and difference tones — energy at frequencies nobody sang,
 * including some that land exactly where a chord's partials are expected.
 *
 * And the app asks for the microphone raw — no gain control, no noise
 * suppression — but that request is a ladder, and its lower rungs drop those
 * flags to get a stream at all. On a device that refuses the raw constraints,
 * everything here arrives gain-ridden and gated, and nothing downstream is told.
 *
 * So: the same synthetic singers, put through all of it, and the same
 * assertions. Ground truth is preserved, which is exactly what a real recording
 * could not have given — nobody knows what a quartet on a 1912 wax cylinder was
 * actually tuned to.
 */

import { rng } from './synth.ts'

export interface PhoneOptions {
  /** Handset bass rolloff. Real ones sit between 150 and 300Hz. */
  highpassHz?: number
  /** Top of the passband. */
  lowpassHz?: number
  /** Reverberation time of the room, in seconds. A church hall is about 1.6. */
  reverb?: number
  /** 0..1 how much of the room you hear against the direct sound. */
  wet?: number
  /** Drive into the preamp's soft knee. 1 is polite, 4 is a chorus at arm's length. */
  drive?: number
  /** Automatic gain control, as applied when the raw-capture request is refused. */
  agc?: boolean
  /** Broadband hiss added at the capsule. */
  noise?: number
  seed?: number
}

/** One biquad, applied in place. */
function biquad(
  x: Float32Array,
  b0: number,
  b1: number,
  b2: number,
  a1: number,
  a2: number,
) {
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i]
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1
    x1 = x0
    y2 = y1
    y1 = y0
    x[i] = y0
  }
}

/** RBJ cookbook highpass, Butterworth Q. */
function highpass(x: Float32Array, rate: number, fc: number) {
  const w0 = (2 * Math.PI * fc) / rate
  const c = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2)
  const a0 = 1 + alpha
  biquad(x, (1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, (-2 * c) / a0, (1 - alpha) / a0)
}

function lowpass(x: Float32Array, rate: number, fc: number) {
  const w0 = (2 * Math.PI * fc) / rate
  const c = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2)
  const a0 = 1 + alpha
  biquad(x, ((1 - c) / 2) / a0, (1 - c) / a0, ((1 - c) / 2) / a0, (-2 * c) / a0, (1 - alpha) / a0)
}

/**
 * A room, as a feedback delay network.
 *
 * Four combs at mutually prime delays into two allpasses — Schroeder's
 * arrangement, which is old and crude and exactly right for this. What matters
 * is not that it sounds like any particular hall but that it does what every
 * hall does: arrive late, repeatedly, so that each partial's measured level is
 * the sum of a dozen copies of itself at different phases.
 */
function room(x: Float32Array, rate: number, rt60: number, wet: number): Float32Array {
  const combs = [1557, 1617, 1491, 1422].map((d) => Math.round((d * rate) / 44100))
  const allpasses = [225, 556].map((d) => Math.round((d * rate) / 44100))
  const out = new Float32Array(x.length)

  for (const d of combs) {
    // Feedback for the wanted decay: g = 10^(-3 * delay / (rt60 * rate)).
    const g = Math.pow(10, (-3 * d) / (rt60 * rate))
    const buf = new Float32Array(d)
    let at = 0
    for (let i = 0; i < x.length; i++) {
      const v = buf[at]
      out[i] += v / combs.length
      buf[at] = x[i] + v * g
      at = (at + 1) % d
    }
  }

  for (const d of allpasses) {
    const g = 0.5
    const buf = new Float32Array(d)
    let at = 0
    for (let i = 0; i < out.length; i++) {
      const v = buf[at]
      const y = -g * out[i] + v
      buf[at] = out[i] + g * y
      out[i] = y
      at = (at + 1) % d
    }
  }

  const dry = 1 - wet
  for (let i = 0; i < x.length; i++) out[i] = x[i] * dry + out[i] * wet
  return out
}

/** Slow gain riding, of the sort a refused `autoGainControl: false` leaves on. */
function agc(x: Float32Array, rate: number) {
  const attack = Math.exp(-1 / (0.01 * rate))
  const release = Math.exp(-1 / (0.4 * rate))
  const target = 0.25
  let env = 0
  let gain = 1
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i])
    env = a > env ? attack * env + (1 - attack) * a : release * env + (1 - release) * a
    const want = env > 1e-5 ? Math.max(0.1, Math.min(10, target / env)) : 1
    // The gain itself moves slowly, which is what makes AGC pump rather than
    // simply normalise.
    gain += (want - gain) * 0.0004
    x[i] *= gain
  }
}

export function throughPhone(
  input: Float32Array,
  rate: number,
  opts: PhoneOptions = {},
): Float32Array {
  const {
    highpassHz = 200,
    lowpassHz = 7800,
    reverb = 1.4,
    wet = 0.32,
    drive = 2.2,
    noise = 0.0012,
    seed = 99,
  } = opts

  // The room comes first: it happens in the air, before the microphone.
  let x = reverb > 0 && wet > 0 ? room(input, rate, reverb, wet) : Float32Array.from(input)

  // The preamp's soft knee. A nonlinearity on a harmonic series makes energy at
  // frequencies nobody sang, and some of them land on the chord's own partials.
  //
  // Normalised into it first, so `drive` means how hard the preamp is being
  // pushed rather than how many voices happen to be in the mix — otherwise the
  // same setting is polite on a quartet and square-waving on a chorus, and
  // every number measured against it means nothing in particular.
  if (drive > 0) {
    let peak = 0
    for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]))
    const norm = peak > 0 ? 0.9 / peak : 1
    const k = Math.tanh(drive)
    for (let i = 0; i < x.length; i++) x[i] = Math.tanh(x[i] * norm * drive) / k
  }

  // The capsule and the port.
  highpass(x, rate, highpassHz)
  highpass(x, rate, highpassHz)
  lowpass(x, rate, lowpassHz)

  const rand = rng(seed)
  for (let i = 0; i < x.length; i++) x[i] += (rand() * 2 - 1) * noise

  if (opts.agc) agc(x, rate)
  return x
}
