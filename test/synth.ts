/**
 * Four people singing, made of arithmetic.
 *
 * The tuner's whole job is a thing that cannot be checked by running the app:
 * it needs four humans holding a chord, and the interesting cases are the ones
 * where they are holding it slightly wrong in a way somebody has to be told
 * about. So the singers are synthetic and the ground truth is an argument.
 *
 * These are not sine waves. A sine wave is trivially easy to find and would let
 * every bug through, and the bugs that matter here are all about partials
 * landing on each other — which is a thing only a harmonic series can do. Each
 * voice gets a realistic partial rolloff, a formant, vibrato, a little drift,
 * and its own noise, and the room gets a floor with more of it low down, where
 * a phone in a rehearsal hall genuinely lives.
 */

export interface Voice {
  freq: number
  gain: number
  /** Partials. A sung vowel has plenty. */
  harmonics?: number
  /** Vibrato depth in cents, and its rate. Zero for a dead straight tone. */
  vibratoCents?: number
  vibratoHz?: number
  /** Cents of slow wander across the take, for the steadiness tests. */
  driftCents?: number
}

/** Deterministic noise, so a failing test fails the same way twice. */
export function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

export function renderChord(
  voices: Voice[],
  sampleRate: number,
  seconds: number,
  opts: { noise?: number; seed?: number; lowRumble?: number } = {},
): Float32Array {
  const n = Math.floor(sampleRate * seconds)
  const out = new Float32Array(n)
  const rand = rng(opts.seed ?? 12345)
  const noise = opts.noise ?? 0.0015
  const rumble = opts.lowRumble ?? 0.02

  for (const v of voices) {
    const harmonics = v.harmonics ?? 12
    const vibDepth = v.vibratoCents ?? 6
    const vibRate = v.vibratoHz ?? 5.2
    const drift = v.driftCents ?? 0
    const vibPhase = rand() * Math.PI * 2
    // Independent phase per partial, which is what stops a synthetic voice
    // having an impulse at t=0 loud enough to be its own transient.
    const phases = new Array(harmonics).fill(0).map(() => rand() * Math.PI * 2)
    // Running phase of the fundamental, integrated rather than computed from t,
    // so vibrato bends the pitch instead of amplitude-modulating it.
    let phase = 0

    for (let i = 0; i < n; i++) {
      const t = i / sampleRate
      const bend =
        vibDepth * Math.sin(2 * Math.PI * vibRate * t + vibPhase) +
        (drift * t) / seconds
      const f = v.freq * Math.pow(2, bend / 1200)
      phase += (2 * Math.PI * f) / sampleRate

      // A gentle attack and release, so the take has the same shape as a real
      // one and the block filter that drops attack and release has work to do.
      const env =
        Math.min(1, t / 0.18) * Math.min(1, Math.max(0, (seconds - t) / 0.22))

      let s = 0
      for (let h = 1; h <= harmonics; h++) {
        // Vowel-ish: partials fall away, with a bump around 700Hz standing in
        // for the first formant.
        const hf = f * h
        const rolloff = Math.pow(h, -1.35)
        const formant = 1 + 0.55 * Math.exp(-Math.pow(Math.log(hf / 700), 2) / 0.5)
        s += rolloff * formant * Math.sin(h * phase + phases[h - 1])
      }
      out[i] += v.gain * env * s * 0.22
    }
  }

  // Room. Broadband hiss plus a low rumble, because the floor a phone sees is
  // steeply tilted and a flat one would make the bass far easier to find than
  // it ever is in a hall.
  let low = 0
  for (let i = 0; i < n; i++) {
    const white = rand() * 2 - 1
    low += (white - low) * 0.02
    out[i] += white * noise + low * rumble
  }
  return out
}

/** Cents to a frequency ratio. */
export function detune(freq: number, cents: number): number {
  return freq * Math.pow(2, cents / 1200)
}
