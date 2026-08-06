/**
 * What the Parts panel has to get right.
 *
 * Every case here is one somebody stood in a room and hit. The chord sung a
 * long way from where the pipe put it is the reported bug in full: it read as
 * four parts missing, and on the frames it did find something it called a
 * perfectly locked chord badly flat.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { FFT, frameMagnitudes, hannWindow } from '../src/audio/fft.ts'
import { NoiseFloor, type Spectrum } from '../src/audio/spectrum.ts'
import {
  alignChord,
  ChordTracker,
  measureChord,
  planChord,
  type ChordMeasurement,
} from '../src/audio/chord.ts'
import { detune, renderChord, type Voice } from './synth.ts'

const RATE = 48000
const SIZE = 16384

/** One spectrum from the middle of a take, the way the live path sees it. */
function spectrumOf(samples: Float32Array, at = 0.5): { spec: Spectrum; floor: NoiseFloor } {
  const fft = new FFT(SIZE)
  const win = hannWindow(SIZE)
  const re = new Float32Array(SIZE)
  const im = new Float32Array(SIZE)
  const mag = new Float32Array(SIZE >> 1)
  const offset = Math.max(
    0,
    Math.min(samples.length - SIZE, Math.floor(samples.length * at - SIZE / 2)),
  )
  frameMagnitudes(samples, offset, win, fft, re, im, mag)
  const spec: Spectrum = { mag, binHz: RATE / SIZE }
  const floor = new NoiseFloor()
  floor.measure(spec)
  return { spec, floor }
}

/** A barbershop seventh on C3, justly tuned: root, 7/4, octave, 5/2. */
const ROOT = 130.813
const SEVENTH = [ROOT, ROOT * (7 / 4), ROOT * 2, ROOT * (5 / 2)]
const PART_NAMES = ['Bass', 'Bari', 'Lead', 'Tenor']

function sing(
  offsets: number[],
  opts: { shift?: number; gains?: number[]; vibrato?: number; seconds?: number } = {},
): Float32Array {
  const shift = opts.shift ?? 0
  const voices: Voice[] = SEVENTH.map((f, i) => ({
    freq: detune(f, shift + offsets[i]),
    gain: opts.gains?.[i] ?? 1,
    vibratoCents: opts.vibrato ?? 6,
    // Spread the rates so the four voices never move together, which would be
    // a chorus of one person.
    vibratoHz: 4.6 + i * 0.5,
  }))
  return renderChord(voices, RATE, opts.seconds ?? 1.4, { seed: 7 + offsets.length })
}

/** Run the whole live path over one spectrum. */
function read(samples: Float32Array, freqs = SEVENTH): ChordMeasurement {
  const { spec, floor } = spectrumOf(samples)
  const plans = planChord(freqs)
  const alignment = alignChord(spec, freqs, floor, null)
  return measureChord(spec, freqs, plans, floor, alignment)
}

test('a chord sung exactly where the pipe put it reads as in tune', () => {
  const m = read(sing([0, 0, 0, 0]))
  assert.ok(m.confidence > 0.3, `confidence ${m.confidence.toFixed(2)}`)
  m.parts.forEach((p, i) => {
    assert.notEqual(p.cents, null, `${PART_NAMES[i]} not heard`)
    assert.ok(
      Math.abs(p.cents as number) < 5,
      `${PART_NAMES[i]} read ${(p.cents as number).toFixed(1)}¢, expected ~0`,
    )
  })
  assert.ok(Math.abs(m.offset) < 6, `offset ${m.offset.toFixed(1)}¢`)
})

test('a chord locked to itself but sung flat is not four broken parts', () => {
  // The reported bug. Four singers, perfectly in tune with each other, sitting
  // where a chorus lands twenty seconds after the pitch was given.
  for (const shift of [-45, -80, -140, 60, 120]) {
    const m = read(sing([0, 0, 0, 0], { shift }))
    m.parts.forEach((p, i) => {
      assert.notEqual(p.cents, null, `${PART_NAMES[i]} not heard at ${shift}¢`)
      assert.ok(
        Math.abs(p.cents as number) <= 6,
        `${PART_NAMES[i]} read ${(p.cents as number).toFixed(1)}¢ with the chord ${shift}¢ out`,
      )
    })
    // ...and the collective drift is still reported, just not as everyone's fault.
    assert.ok(
      Math.abs(m.offset - shift) < 12,
      `offset read ${m.offset.toFixed(1)}¢, chord was at ${shift}¢`,
    )
  }
})

test('one part out is the one part reported', () => {
  for (const culprit of [0, 1, 2, 3]) {
    for (const error of [-22, 18]) {
      const offsets = [0, 0, 0, 0]
      offsets[culprit] = error
      const m = read(sing(offsets, { shift: -35 }))

      const read_ = m.parts[culprit].cents
      assert.notEqual(read_, null, `${PART_NAMES[culprit]} not heard`)
      assert.ok(
        Math.abs((read_ as number) - error) < 9,
        `${PART_NAMES[culprit]} sang ${error}¢ out, read ${(read_ as number).toFixed(1)}¢`,
      )
      // Everyone else stays innocent.
      m.parts.forEach((p, i) => {
        if (i === culprit) return
        assert.ok(
          p.cents !== null && Math.abs(p.cents) < 9,
          `${PART_NAMES[i]} blamed (${p.cents?.toFixed(1)}¢) for ${PART_NAMES[culprit]}`,
        )
      })
    }
  }
})

test('the bari on an equal-tempered seventh reads as the 31 cents it is', () => {
  // The signature case: a bari singing the piano's B♭ instead of the harmonic
  // seventh. It is 31¢ sharp of where the chord wants it and must say so.
  const equalBari = 1200 * Math.log2(Math.pow(2, 10 / 12) / (7 / 4))
  const m = read(sing([0, equalBari, 0, 0]))
  const bari = m.parts[1].cents
  assert.notEqual(bari, null, 'bari not heard')
  assert.ok(
    Math.abs((bari as number) - equalBari) < 9,
    `bari read ${(bari as number).toFixed(1)}¢, expected ${equalBari.toFixed(1)}¢`,
  )
})

test('a quiet part is still found under three loud ones', () => {
  // The tenor is the top of the chord and habitually the quietest thing in it.
  const m = read(sing([0, 0, 0, 14], { gains: [1, 1, 1, 0.22] }))
  assert.notEqual(m.parts[3].cents, null, 'tenor lost under the others')
  assert.ok(
    Math.abs((m.parts[3].cents as number) - 14) < 10,
    `tenor read ${(m.parts[3].cents as number).toFixed(1)}¢, sang 14¢`,
  )
})

test('a part that is not singing reads as not heard, not as in tune', () => {
  const voices: Voice[] = SEVENTH.slice(0, 3).map((f, i) => ({
    freq: f,
    gain: 1,
    vibratoHz: 4.6 + i * 0.5,
  }))
  const m = read(renderChord(voices, RATE, 1.4, { seed: 3 }))
  assert.equal(m.parts[3].cents, null, 'tenor invented')
  m.parts.slice(0, 3).forEach((p, i) => {
    assert.notEqual(p.cents, null, `${PART_NAMES[i]} not heard`)
  })
})

test('silence is not a chord', () => {
  const m = read(renderChord([], RATE, 1.4, { seed: 5, noise: 0.004 }))
  assert.ok(m.confidence < 0.3, `confidence ${m.confidence.toFixed(2)} on an empty room`)
})

test('the octave doubling in the voicing is flagged, not silently attributed', () => {
  // Lead at 2/1 has no partial the bass does not also land on.
  const plans = planChord(SEVENTH)
  assert.equal(plans[2].shared, true, 'lead should be flagged as sharing every partial')
  assert.equal(plans[0].shared, false, 'bass has clean partials of its own')
})

test('a chord sung correctly accuses nobody of being an octave out', () => {
  // Every even multiple of the octave below a part is exactly where that part's
  // own partials are when it is singing the right note, so a test that looks at
  // the whole series down there passes the moment anyone sings — and three
  // parts singing perfectly were each told they were an octave low.
  for (const shift of [0, -40, 70]) {
    const m = read(sing([0, 0, 0, 20], { shift }))
    m.parts.forEach((p, i) => {
      assert.equal(p.octave, 0, `${PART_NAMES[i]} wrongly called an octave out at ${shift}\u00a2`)
    })
  }
})

test('a hum an octave below a part is not that part singing low', () => {
  // A room mode, an amplifier buzz, a fridge — something sitting on a single
  // low frequency that happens to be an octave under one of the parts. It puts
  // energy exactly where a part singing an octave low would put its
  // fundamental, and it is *not* that: a voice down there would also be sounding
  // three and five times that frequency, and a hum sounds at one.
  const bass = SEVENTH[0]
  const voices: Voice[] = SEVENTH.map((f, i) => ({
    freq: f,
    gain: 1,
    vibratoHz: 4.6 + i * 0.5,
  }))
  // Loud, steady, and with almost nothing above its own fundamental.
  voices.push({ freq: bass / 2, gain: 0.85, harmonics: 1, vibratoCents: 0 })
  const m = read(renderChord(voices, RATE, 1.4, { seed: 19 }))
  assert.equal(m.parts[0].octave, 0, 'a hum was reported as the bass singing an octave low')
  assert.notEqual(m.parts[0].cents, null, 'bass lost')
})

test('a part an octave out is named rather than reported missing', () => {
  const voices: Voice[] = [
    { freq: SEVENTH[0], gain: 1, vibratoHz: 4.6 },
    { freq: SEVENTH[1], gain: 1, vibratoHz: 5.1 },
    { freq: SEVENTH[2], gain: 1, vibratoHz: 5.6 },
    // Tenor an octave below where the voicing puts them.
    { freq: SEVENTH[3] / 2, gain: 1, vibratoHz: 6.1 },
  ]
  const m = read(renderChord(voices, RATE, 1.4, { seed: 11 }))
  assert.equal(m.parts[3].octave, -1, 'tenor singing an octave low was not spotted')
})

test('the other voicings hold up too', () => {
  // Major, minor 7th and major 6th, each with a different part out. The
  // collisions differ per voicing — the minor 7th's 9/5 bari and the 6th's 5/3
  // land on different rungs from the barbershop 7th's 7/4 — so a scheme that
  // only works on one voicing is worth catching here.
  const voicings: Record<string, number[]> = {
    Major: [1, 3 / 2, 2, 5 / 2],
    'Minor 7th': [1, 9 / 5, 2, 12 / 5],
    'Major 6th': [1, 5 / 3, 2, 5 / 2],
  }
  for (const [name, ratios] of Object.entries(voicings)) {
    const freqs = ratios.map((r) => ROOT * r)
    for (const culprit of [0, 1, 3]) {
      const offsets = [0, 0, 0, 0]
      offsets[culprit] = -20
      const voices: Voice[] = freqs.map((f, i) => ({
        freq: detune(f, -50 + offsets[i]),
        gain: 1,
        vibratoHz: 4.6 + i * 0.5,
      }))
      const m = read(renderChord(voices, RATE, 1.4, { seed: 21 }), freqs)
      const got = m.parts[culprit].cents
      assert.notEqual(got, null, `${name}: ${PART_NAMES[culprit]} not heard`)
      assert.ok(
        Math.abs((got as number) + 20) < 10,
        `${name}: ${PART_NAMES[culprit]} sang -20¢, read ${(got as number).toFixed(1)}¢`,
      )
    }
  }
})

// --- holding still ----------------------------------------------------------

test('a part that drops out for one frame does not blink', () => {
  const tracker = new ChordTracker()
  const good = read(sing([0, 0, 0, 0]))
  // Settle.
  for (let i = 0; i < 20; i++) tracker.update(good, i * 33)

  const gap: ChordMeasurement = {
    ...good,
    parts: good.parts.map((p, i) =>
      i === 3 ? { ...p, cents: null, strength: 0 } : p,
    ),
  }
  const after = tracker.update(gap, 21 * 33)
  assert.notEqual(after.parts[3].cents, null, 'one missed frame blanked the row')

  // Genuinely gone, though, and it goes.
  let last = after
  for (let i = 22; i < 45; i++) last = tracker.update(gap, i * 33)
  assert.equal(last.parts[3].cents, null, 'a part that stopped singing stayed on screen')
})

test('ringing needs to be held, and does not strobe', () => {
  const tracker = new ChordTracker()
  const locked = read(sing([0, 0, 0, 0]))
  let r = tracker.update(locked, 0)
  assert.equal(r.ringing, false, 'called it on the first frame')
  for (let i = 1; i < 30; i++) r = tracker.update(locked, i * 33)
  assert.equal(r.ringing, true, 'a held, locked chord never rang')
  assert.ok(r.lock > 0.99, `lock ${r.lock.toFixed(2)}`)

  // One bad frame must not put the light out.
  const wobble: ChordMeasurement = {
    ...locked,
    parts: locked.parts.map((p, i) => (i === 1 ? { ...p, cents: 30 } : p)),
  }
  const blip = tracker.update(wobble, 30 * 33)
  assert.equal(blip.ringing, true, 'one frame of wobble killed the ring')
})

test('a chord with one part out does not ring', () => {
  const tracker = new ChordTracker()
  const m = read(sing([0, 0, 0, 22]))
  let r = tracker.update(m, 0)
  for (let i = 1; i < 40; i++) r = tracker.update(m, i * 33)
  assert.equal(r.ringing, false, 'rang with the tenor 22¢ out')
  assert.ok(r.lock > 0.6 && r.lock < 0.8, `lock ${r.lock.toFixed(2)}, expected three of four`)
})

test('a chord sung flat as a whole still rings', () => {
  const tracker = new ChordTracker()
  const m = read(sing([0, 0, 0, 0], { shift: -110 }))
  let r = tracker.update(m, 0)
  for (let i = 1; i < 30; i++) r = tracker.update(m, i * 33)
  assert.equal(r.ringing, true, 'a locked chord sung flat was refused')
  assert.ok(
    Math.abs(r.offset + 110) < 15,
    `offset read ${r.offset.toFixed(1)}¢, chord was 110¢ flat`,
  )
})
