/**
 * What the ring test has to get right.
 *
 * The reported bug is one line: it never said a chord rang. Two of these tests
 * are that bug directly — a justly tuned chord held steady must score as rung,
 * and it must still do so when the whole quartet is singing a long way from the
 * pitch they were given, since ringing is a relationship between four voices
 * and has nothing to do with where they all are.
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { analyseRing, type RingTarget } from '../src/audio/ring.ts'
import { detune, renderChord, type Voice } from './synth.ts'

const RATE = 48000
const ROOT = 130.813

/** A barbershop seventh, as ratios against the bass. */
const SEVENTH: RingTarget[] = [
  { part: 'Bass', num: 1, den: 1 },
  { part: 'Bari', num: 7, den: 4 },
  { part: 'Lead', num: 2, den: 1 },
  { part: 'Tenor', num: 5, den: 2 },
]

const MAJOR: RingTarget[] = [
  { part: 'Bass', num: 1, den: 1 },
  { part: 'Bari', num: 3, den: 2 },
  { part: 'Lead', num: 2, den: 1 },
  { part: 'Tenor', num: 5, den: 2 },
]

function take(
  targets: RingTarget[],
  offsets: number[],
  opts: { shift?: number; root?: number; seconds?: number; vibrato?: number; gains?: number[] } = {},
) {
  const root = opts.root ?? ROOT
  const voices: Voice[] = targets.map((t, i) => ({
    freq: detune(root * (t.num / t.den), (opts.shift ?? 0) + offsets[i]),
    gain: opts.gains?.[i] ?? 1,
    vibratoCents: opts.vibrato ?? 5,
    vibratoHz: 4.7 + i * 0.4,
  }))
  const samples = renderChord(voices, RATE, opts.seconds ?? 3, { seed: 31 })
  return analyseRing({ samples, sampleRate: RATE }, targets, root)
}

test('a justly tuned chord, held, rings', () => {
  const r = take(SEVENTH, [0, 0, 0, 0])
  assert.equal(r.problem, undefined, r.problem)
  assert.ok(r.score >= 85, `scored ${r.score}, expected a ring`)
  // And it found the bass where the bass was, not on somebody's octave.
  assert.ok(
    Math.abs(1200 * Math.log2(r.rootHz / ROOT)) < 12,
    `root read ${r.rootHz.toFixed(1)}Hz, sang ${ROOT.toFixed(1)}Hz`,
  )
})

test('a chord that rings still rings when the whole quartet is flat', () => {
  // The complaint, in full. Ringing is four voices agreeing with each other;
  // where they collectively sit is a different question and is not this one.
  for (const shift of [-120, -60, 55, 130]) {
    const r = take(SEVENTH, [0, 0, 0, 0], { shift })
    assert.equal(r.problem, undefined, `${shift}¢: ${r.problem}`)
    assert.ok(r.score >= 85, `${shift}¢ flat scored ${r.score}`)
  }
})

test('the major voicing rings too', () => {
  const r = take(MAJOR, [0, 0, 0, 0])
  assert.ok(r.score >= 85, `scored ${r.score}`)
})

test('an equal-tempered seventh does not ring, and the bari is named', () => {
  // The case the whole style turns on: a bari singing the piano's B♭ is 31¢
  // above the harmonic seventh, and that is what stops the chord expanding.
  const equalBari = 1200 * Math.log2(Math.pow(2, 10 / 12) / (7 / 4))
  const r = take(SEVENTH, [0, equalBari, 0, 0])
  assert.ok(r.score < 60, `scored ${r.score}, an equal-tempered 7th should not ring`)

  const bari = r.parts.find((p) => p.part === 'Bari')
  assert.ok(bari && bari.cents !== null, 'bari not measured')
  assert.ok(
    Math.abs((bari!.cents as number) - equalBari) < 10,
    `bari read ${bari!.cents?.toFixed(1)}¢, sang ${equalBari.toFixed(1)}¢`,
  )
  // And nobody else is blamed for it.
  for (const p of r.parts) {
    if (p.part === 'Bari' || p.cents === null) continue
    assert.ok(Math.abs(p.cents) < 10, `${p.part} blamed at ${p.cents.toFixed(1)}¢`)
  }
})

test('the score tracks how far out one part is', () => {
  // Monotonic, so the number means something to somebody trying to fix it.
  const scores = [0, 8, 18, 35].map((err) => take(SEVENTH, [0, 0, 0, err]).score)
  for (let i = 1; i < scores.length; i++) {
    assert.ok(
      scores[i] < scores[i - 1],
      `score did not fall: ${scores.join(' → ')}`,
    )
  }
  assert.ok(scores[0] >= 85, `in tune scored ${scores[0]}`)
  assert.ok(scores[3] < 45, `35¢ out scored ${scores[3]}`)
})

test('a part that is silent is not scored as a part that is perfect', () => {
  const targets = SEVENTH
  const voices: Voice[] = targets.slice(0, 3).map((t, i) => ({
    freq: ROOT * (t.num / t.den),
    gain: 1,
    vibratoHz: 4.7 + i * 0.4,
  }))
  const samples = renderChord(voices, RATE, 3, { seed: 33 })
  const r = analyseRing({ samples, sampleRate: RATE }, targets, ROOT)
  const tenor = r.parts.find((p) => p.part === 'Tenor')
  assert.equal(tenor?.cents, null, 'invented a tenor')
  // The three that did sing locked, so the report should say so rather than
  // scoring the silence as a failure to ring.
  assert.ok(r.score >= 75, `three locked parts scored ${r.score}`)
})

test('a wandering part is reported as wandering', () => {
  const voices: Voice[] = SEVENTH.map((t, i) => ({
    freq: ROOT * (t.num / t.den),
    gain: 1,
    vibratoHz: 4.7 + i * 0.4,
    // The tenor slides 40¢ across the take.
    driftCents: i === 3 ? 40 : 0,
  }))
  const samples = renderChord(voices, RATE, 3, { seed: 37 })
  const r = analyseRing({ samples, sampleRate: RATE }, SEVENTH, ROOT)
  const tenor = r.parts.find((p) => p.part === 'Tenor')
  assert.ok(tenor && tenor.steadiness < 0.6, `steadiness ${tenor?.steadiness.toFixed(2)}`)
  const bass = r.parts.find((p) => p.part === 'Bass')
  assert.ok(bass && bass.steadiness > 0.7, `bass steadiness ${bass?.steadiness.toFixed(2)}`)
})

test('the bass is found even when the lead is louder than it', () => {
  // A spread voicing on a phone: the bass fundamental is the weakest thing in
  // the room and the lead's octave is the strongest. Building the ladder on the
  // octave would halve every harmonic number in the report.
  const r = take(SEVENTH, [0, 0, 0, 0], { gains: [0.3, 1, 1.4, 1] })
  assert.ok(
    Math.abs(1200 * Math.log2(r.rootHz / ROOT)) < 12,
    `root read ${r.rootHz.toFixed(1)}Hz, sang ${ROOT.toFixed(1)}Hz`,
  )
  assert.ok(r.score >= 80, `scored ${r.score}`)
})

test('a room with nobody in it says so rather than scoring zero', () => {
  const samples = renderChord([], RATE, 3, { seed: 41, noise: 0.004 })
  const r = analyseRing({ samples, sampleRate: RATE }, SEVENTH, ROOT)
  assert.ok(r.problem, 'silence was analysed as a chord')
})
