/**
 * The same singers, through a phone.
 *
 * Every case here uses material whose tuning is known exactly and then ruins it
 * the way a handset in a rehearsal hall ruins it: the room first, then a preamp
 * driven hard by forty people at arm's length, then a capsule that cannot hear
 * a bass, then — where the raw-capture request was refused — gain control on
 * top. If the readings survive that, the microphone is not what was wrong.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { FFT, frameMagnitudes, hannWindow } from '../src/audio/fft.ts'
import { NoiseFloor, type Spectrum } from '../src/audio/spectrum.ts'
import {
  alignChord,
  measureChord,
  planChord,
  type ChordMeasurement,
} from '../src/audio/chord.ts'
import { analyseRing, type RingTarget } from '../src/audio/ring.ts'
import { detune, renderChord, type Voice } from './synth.ts'
import { throughPhone, type PhoneOptions } from './phone.ts'

const RATE = 48000
const SIZE = 16384
const PART_NAMES = ['Bass', 'Bari', 'Lead', 'Tenor']

/** A barbershop seventh on C3 — low enough that the bass is in real trouble. */
const ROOT = 130.813
const RATIOS = [1, 7 / 4, 2, 5 / 2]
const SEVENTH = RATIOS.map((r) => ROOT * r)
const TARGETS: RingTarget[] = [
  { part: 'Bass', num: 1, den: 1 },
  { part: 'Bari', num: 7, den: 4 },
  { part: 'Lead', num: 2, den: 1 },
  { part: 'Tenor', num: 5, den: 2 },
]

/**
 * A section rather than a soloist.
 *
 * A chorus is not four voices, it is four *groups*, each spread over a few
 * cents and never quite together. That turns every partial from a spike into a
 * mound, which is a harder thing to find the centre of — and it is the case the
 * app is actually for.
 */
function section(freq: number, count: number, spreadCents: number, i: number): Voice[] {
  const out: Voice[] = []
  for (let k = 0; k < count; k++) {
    const off = count === 1 ? 0 : spreadCents * (k / (count - 1) - 0.5)
    out.push({
      freq: detune(freq, off),
      gain: 1 / Math.sqrt(count),
      vibratoCents: 5 + k,
      vibratoHz: 4.5 + i * 0.4 + k * 0.31,
    })
  }
  return out
}

function chorus(
  offsets: number[],
  opts: { shift?: number; perPart?: number; spread?: number; seconds?: number } = {},
): Float32Array {
  const voices: Voice[] = []
  SEVENTH.forEach((f, i) => {
    voices.push(
      ...section(
        detune(f, (opts.shift ?? 0) + offsets[i]),
        opts.perPart ?? 1,
        opts.spread ?? 12,
        i,
      ),
    )
  })
  return renderChord(voices, RATE, opts.seconds ?? 2.2, { seed: 41 })
}

function readThrough(samples: Float32Array, phone: PhoneOptions = {}): ChordMeasurement {
  const s = throughPhone(samples, RATE, phone)
  const fft = new FFT(SIZE)
  const win = hannWindow(SIZE)
  const re = new Float32Array(SIZE)
  const im = new Float32Array(SIZE)
  const mag = new Float32Array(SIZE >> 1)
  frameMagnitudes(s, Math.max(0, Math.floor(s.length * 0.55 - SIZE / 2)), win, fft, re, im, mag)
  const spec: Spectrum = { mag, binHz: RATE / SIZE }
  const floor = new NoiseFloor()
  floor.measure(spec)
  const plans = planChord(SEVENTH)
  return measureChord(spec, SEVENTH, plans, floor, alignChord(spec, SEVENTH, floor, null))
}

// --- the capsule ------------------------------------------------------------

test('a bass whose fundamental the phone cannot hear is still measured', () => {
  // C3 is 131Hz. Two cascaded highpasses at 260Hz put its fundamental about
  // 24dB down — which is the ordinary case, not a pathological one, and the
  // reason a scheme that measures each part at its fundamental cannot work
  // here. The bass has to be read off its upper partials or not at all.
  const m = readThrough(chorus([0, 0, 0, 0], { shift: -55 }), { highpassHz: 260 })
  assert.notEqual(m.parts[0].cents, null, 'bass lost to the handset rolloff')
  assert.ok(
    Math.abs(m.parts[0].cents as number) < 8,
    `bass read ${(m.parts[0].cents as number).toFixed(1)}¢ through a 260Hz highpass`,
  )
})

test('the whole chord survives a hall, a hot preamp and a small capsule', () => {
  for (const shift of [0, -60, -130]) {
    const m = readThrough(chorus([0, 0, 0, 0], { shift }))
    m.parts.forEach((p, i) => {
      assert.notEqual(p.cents, null, `${PART_NAMES[i]} not heard at ${shift}¢`)
      assert.ok(
        Math.abs(p.cents as number) <= 8,
        `${PART_NAMES[i]} read ${(p.cents as number).toFixed(1)}¢ through a phone`,
      )
      assert.equal(p.octave, 0, `${PART_NAMES[i]} wrongly called an octave out`)
    })
    assert.ok(
      Math.abs(m.offset - shift) < 15,
      `offset read ${m.offset.toFixed(1)}¢, chord was at ${shift}¢`,
    )
  }
})

test('one part out is still the one part reported, through a phone', () => {
  for (const culprit of [0, 1, 3]) {
    const offsets = [0, 0, 0, 0]
    offsets[culprit] = 24
    const m = readThrough(chorus(offsets, { shift: -70 }))
    const got = m.parts[culprit].cents
    assert.notEqual(got, null, `${PART_NAMES[culprit]} not heard`)
    assert.ok(
      Math.abs((got as number) - 24) < 11,
      `${PART_NAMES[culprit]} sang 24¢ out, read ${(got as number).toFixed(1)}¢`,
    )
    m.parts.forEach((p, i) => {
      if (i === culprit) return
      assert.ok(
        p.cents !== null && Math.abs(p.cents) < 11,
        `${PART_NAMES[i]} blamed (${p.cents?.toFixed(1)}¢) for ${PART_NAMES[culprit]}`,
      )
    })
  }
})

test('a chorus of forty, not a quartet of four', () => {
  // Eight to a part, spread over sixteen cents. Every partial is a mound rather
  // than a spike, which is the case this app is actually for and the one where
  // a peak picker has the least to hold on to.
  const m = readThrough(chorus([0, 0, 0, 18], { shift: -40, perPart: 8, spread: 16 }))
  m.parts.forEach((p, i) => {
    assert.notEqual(p.cents, null, `${PART_NAMES[i]} not heard in a chorus`)
  })
  assert.ok(
    Math.abs((m.parts[3].cents as number) - 18) < 12,
    `tenor section sang 18¢ out, read ${(m.parts[3].cents as number).toFixed(1)}¢`,
  )
})

test('gain control and noise suppression left on do not move the pitch', () => {
  // What the constraint ladder leaves you with on a device that refuses a raw
  // capture. It should cost level accuracy, not tuning.
  const m = readThrough(chorus([0, 0, 0, 0], { shift: -50 }), { agc: true, drive: 3.5 })
  m.parts.forEach((p, i) => {
    assert.notEqual(p.cents, null, `${PART_NAMES[i]} not heard with AGC on`)
    assert.ok(
      Math.abs(p.cents as number) <= 8,
      `${PART_NAMES[i]} read ${(p.cents as number).toFixed(1)}¢ with AGC on`,
    )
  })
})

test('a quiet preamp does not invent a part', () => {
  // Below about a tenth of a percent of distortion the microphone adds nothing
  // that looks like a singer, and a part nobody is singing reads as absent.
  const voices: Voice[] = []
  SEVENTH.slice(0, 3).forEach((f, i) => voices.push(...section(detune(f, -30), 1, 0, i)))
  const clean = renderChord(voices, RATE, 2.2, { seed: 43 })
  for (const drive of [0, 0.1]) {
    const m = readThrough(clean, { drive })
    assert.equal(m.parts[3].cents, null, `a tenor was invented at drive ${drive}`)
  }
})

test('KNOWN LIMIT: a driven preamp counterfeits a missing part', () => {
  // Pinned deliberately, so that the day this stops being true somebody is told.
  //
  // A saturating preamp makes energy at sums and differences of everything
  // present, and in a justly tuned chord those combinations are the chord. The
  // bari's harmonic seventh, doubled, less the bass, is 2 × 7/4 − 1 = 5/2 — the
  // tenor's note, exactly. The same arithmetic that makes a just chord ring is
  // the arithmetic a nonlinearity runs, so distortion fills in a missing part
  // at precisely the right pitch, with a full harmonic series of its own, and
  // reads as perfectly in tune.
  //
  // This is not a peak picker that could be sharpened. The energy is genuinely
  // there at genuinely that frequency, and nothing that looks only at that
  // frequency can tell the two apart. The threshold is low — under half a
  // percent of total harmonic distortion, which is what a handset does when
  // somebody holds it in front of a loud chorus.
  //
  // Distinguishing them needs a different kind of evidence: an intermodulation
  // product's frequency wobbles with the *sum* of the vibrato of the voices
  // that made it, while a singer's wobbles on its own. That is a real signal
  // and it is a research problem, not a threshold.
  const voices: Voice[] = []
  SEVENTH.slice(0, 3).forEach((f, i) => voices.push(...section(detune(f, -30), 1, 0, i)))
  const m = readThrough(renderChord(voices, RATE, 2.2, { seed: 43 }), { drive: 1.5 })
  assert.notEqual(
    m.parts[3].cents,
    null,
    'the counterfeit is gone — good news, and this test should now be rewritten',
  )
})

// --- the ring test ----------------------------------------------------------

test('the ring test still says a locked chord rang, through a phone', () => {
  const samples = throughPhone(chorus([0, 0, 0, 0], { shift: -60, seconds: 3 }), RATE)
  const r = analyseRing({ samples, sampleRate: RATE }, TARGETS, ROOT)
  assert.equal(r.problem, undefined, r.problem)
  assert.ok(r.score >= 80, `a locked chord through a phone scored ${r.score}`)
  // ...and it found the bass, whose fundamental is barely present.
  assert.ok(
    Math.abs(1200 * Math.log2(r.rootHz / detune(ROOT, -60))) < 15,
    `root read ${r.rootHz.toFixed(1)}Hz, sang ${detune(ROOT, -60).toFixed(1)}Hz`,
  )
})

test('the ring test still names the part that broke it, through a phone', () => {
  const samples = throughPhone(chorus([0, 0, 0, 25], { shift: -60, seconds: 3 }), RATE)
  const r = analyseRing({ samples, sampleRate: RATE }, TARGETS, ROOT)
  assert.ok(r.score < 65, `a chord with the tenor 25¢ out scored ${r.score}`)
  const tenor = r.parts.find((p) => p.part === 'Tenor')
  assert.ok(tenor?.cents != null, 'tenor not measured')
  assert.ok(
    Math.abs((tenor!.cents as number) - 25) < 12,
    `tenor sang 25¢ out, read ${tenor!.cents?.toFixed(1)}¢`,
  )
})
