/**
 * Listening to singers.
 *
 * Two questions, one microphone:
 *
 *   "What note am I singing, and how far off is it?"  → `readVoice`
 *   "Which part of this chord isn't locking in?"      → `readChord`
 *
 * They need very different signal processing. A single voice is a periodic
 * waveform and the reliable way to find its period is in the time domain, so
 * that path autocorrelates. A chord is four overlapping harmonic series and
 * nothing in the time domain will separate them, so that path works from the
 * spectrum, and lives in `chord.ts` — where the reasoning about collisions,
 * drift and holding still is long enough to be worth its own file, and is
 * shared with the ring test rather than written twice.
 */

import { closeMicrophone, openMicrophone, type MicErrorKind } from './mic'
import { freqToMidi } from '../music/notes'
import { NoiseFloor, type Spectrum } from './spectrum'
import {
  alignChord,
  ChordTracker,
  measureChord,
  planChord,
  type ChordReading,
  type PartPlan,
} from './chord'

export {
  IN_TUNE_CENTS,
  CENTS_RANGE,
  type ChordReading,
  type PartReading,
} from './chord'

export type AnalyzerStatus = 'idle' | 'requesting' | 'listening' | 'denied' | 'error'

export interface VoiceReading {
  /** Measured fundamental in Hz, or 0 when nothing usable is being sung. */
  freq: number
  /** Nearest equal-tempered note, at the current concert pitch. */
  midi: number
  /** Signed cents from that note. Positive is sharp. */
  cents: number
  /** 0..1 confidence that this is one periodic voice rather than noise. */
  clarity: number
  /** 0..1 loudness, for the level indicator. */
  level: number
}

// --- single voice -----------------------------------------------------------

/** Vocal range we bother searching, generously either side of a chorus. */
const MIN_FREQ = 60
const MAX_FREQ = 1300
/**
 * Rate the autocorrelation runs at. Pitch lives in the bottom couple of
 * kilohertz and the cost of autocorrelation is quadratic in sample rate, so the
 * signal is lowpassed and decimated first. Nothing above the third or fourth
 * harmonic of a sung note contributes anything to finding its period.
 */
const TARGET_RATE = 8000
/** Decimated samples the period search runs over — about an eighth of a second. */
const WINDOW = 1024
/** Below this the peak isn't periodic enough to call a pitch. */
const MIN_CLARITY = 0.72
/** MPM's rule: prefer the *first* peak within this fraction of the best one. */
const PEAK_TOLERANCE = 0.9

// --- chord ------------------------------------------------------------------

/**
 * Highest frequency the chord path bothers converting out of the analyser.
 *
 * Nothing above the sixth partial of the top voice is measured, and turning
 * eight thousand decibel readings into linear magnitudes thirty times a second
 * to look at two thousand of them is work for nobody.
 */
const CHORD_MAX_HZ = 6000

export interface AnalyzerTarget {
  freq: number
}

export class PitchAnalyzer {
  private stream: MediaStream | null = null
  private ctx: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private filters: BiquadFilterNode[] = []
  /** Lowpassed, for the time-domain period search. */
  private voiceAnalyser: AnalyserNode | null = null
  /** Straight from the microphone, high resolution, for the chord path. */
  private specAnalyser: AnalyserNode | null = null
  private raf = 0

  private timeBuf = new Float32Array(0)
  private freqBuf = new Float32Array(0)
  private decimated = new Float32Array(WINDOW)
  private nsdf = new Float32Array(0)

  private decimation = 1
  private rate = TARGET_RATE
  private lastRun = 0
  /** Analysis is suspended while our own reed is sounding. */
  private mutedUntil = 0

  /** Recent frequency estimates, for rejecting one-frame octave slips. */
  private history: number[] = []

  // The chord path. The spectrum is linear magnitude rather than the decibels
  // the analyser hands out, because every threshold downstream is a ratio
  // against the local background and ratios are what linear magnitudes are for.
  private spectrum: Spectrum = { mag: new Float32Array(0), binHz: 1 }
  private floor = new NoiseFloor()
  private floorScratch: number[] = []
  private tracker = new ChordTracker()
  private plans: PartPlan[] = []
  private planned: number[] = []

  status: AnalyzerStatus = 'idle'

  /** Concert pitch, so cents are measured against what the pipe is playing. */
  a4 = 440
  /** Non-empty puts the analyser in chord mode. */
  targets: AnalyzerTarget[] = []
  deviceId: string | null = null

  constructor(
    private onVoice: (r: VoiceReading) => void,
    private onChord: (r: ChordReading) => void,
    private onStatus: (s: AnalyzerStatus, detail?: string) => void,
  ) {}

  async start(context: AudioContext): Promise<boolean> {
    if (this.stream) return true
    this.setStatus('requesting')

    const result = await openMicrophone(this.deviceId)
    if (!result.stream) {
      this.setStatus(
        result.kind === 'denied' ? 'denied' : 'error',
        result.detail ?? errorText(result.kind),
      )
      return false
    }
    this.stream = result.stream
    this.ctx = context
    this.source = context.createMediaStreamSource(this.stream)

    this.decimation = Math.max(1, Math.round(context.sampleRate / TARGET_RATE))
    this.rate = context.sampleRate / this.decimation

    // Anti-aliasing before decimation. Three poles rather than one because a
    // gentle rolloff folds sibilance straight back down into the range the
    // period search cares about, where it looks like noise.
    let node: AudioNode = this.source
    this.filters = []
    for (let i = 0; i < 3; i++) {
      const lp = context.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = this.rate * 0.4
      lp.Q.value = 0.7
      node.connect(lp)
      node = lp
      this.filters.push(lp)
    }

    this.voiceAnalyser = context.createAnalyser()
    // Enough raw samples that decimating still leaves a full window.
    this.voiceAnalyser.fftSize = nextPow2(WINDOW * this.decimation)
    this.voiceAnalyser.smoothingTimeConstant = 0
    node.connect(this.voiceAnalyser)

    // The chord path wants frequency resolution above all else: at 16384 the
    // bins are about 3 Hz apart, which is what makes single-figure cents
    // readable on a bass note. It reads the microphone directly, since the
    // anti-aliasing filter above would flatten the upper harmonics it measures.
    const spec = context.createAnalyser()
    spec.fftSize = 16384
    // Light smoothing only. The window is already a third of a second long, and
    // holding readings still is now the tracker's job, done where it can tell
    // the difference between a part that stopped and a frame that missed.
    spec.smoothingTimeConstant = 0.25
    this.source.connect(spec)
    this.specAnalyser = spec

    // Neither analyser is connected onward. Routing a microphone to the
    // speakers in a room full of singers would be a feedback disaster.

    this.timeBuf = new Float32Array(this.voiceAnalyser.fftSize)
    this.freqBuf = new Float32Array(spec.frequencyBinCount)
    this.nsdf = new Float32Array(Math.floor(this.rate / MIN_FREQ) + 2)
    this.history = []

    const binHz = context.sampleRate / spec.fftSize
    this.spectrum = {
      mag: new Float32Array(Math.min(spec.frequencyBinCount, Math.ceil(CHORD_MAX_HZ / binHz))),
      binHz,
    }
    this.floor = new NoiseFloor(55, Math.min(CHORD_MAX_HZ, context.sampleRate / 2.2))
    this.tracker.reset()
    this.plans = []
    this.planned = []

    this.setStatus('listening')
    this.loop()
    return true
  }

  stop() {
    cancelAnimationFrame(this.raf)
    this.raf = 0
    this.source?.disconnect()
    for (const f of this.filters) f.disconnect()
    this.filters = []
    this.source = null
    this.voiceAnalyser = null
    this.specAnalyser = null
    if (this.stream) closeMicrophone(this.stream)
    this.stream = null
    this.history = []
    this.setStatus('idle')
  }

  /**
   * Stop reading for a moment. The reference tone is dead on pitch and much
   * louder at the microphone than anyone singing, so measuring while it sounds
   * would just report the app back to itself.
   */
  mute(ms: number) {
    this.mutedUntil = performance.now() + ms
    this.history = []
  }

  private setStatus(s: AnalyzerStatus, detail?: string) {
    this.status = s
    this.onStatus(s, detail)
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop)
    const now = performance.now()
    // Analysis is far heavier than a repaint and nothing about a held note
    // changes in 16ms, so it runs at about 30Hz and leaves the frame alone.
    if (now - this.lastRun < 30) return
    this.lastRun = now
    if (now < this.mutedUntil) return
    if (this.targets.length > 0) this.readChord()
    else this.readVoice()
  }

  // --- one voice ----------------------------------------------------------

  /**
   * Period detection by the McLeod method: a normalised square difference
   * function, then the first peak that comes within a whisker of the best one.
   *
   * That last rule is the whole reason to use NSDF over plain autocorrelation.
   * A voice correlates just as well at twice its period as at its true one, so
   * "tallest peak wins" reports the octave below roughly whenever the singer
   * has a strong second harmonic. Taking the *first* peak that is nearly as
   * good picks the true period instead.
   */
  private readVoice() {
    const analyser = this.voiceAnalyser
    if (!analyser) return
    analyser.getFloatTimeDomainData(this.timeBuf)

    // Decimate from the end of the buffer — the most recent audio.
    const dec = this.decimation
    const start = this.timeBuf.length - WINDOW * dec
    let sum = 0
    for (let i = 0; i < WINDOW; i++) {
      const v = this.timeBuf[start + i * dec]
      this.decimated[i] = v
      sum += v * v
    }
    const level = Math.sqrt(sum / WINDOW)

    // Too quiet to be a voice at all. Reporting a pitch from the room tone
    // would leave a number flickering on screen that means nothing.
    if (level < 0.004) {
      this.history = []
      this.onVoice({ freq: 0, midi: 0, cents: 0, clarity: 0, level })
      return
    }

    const minLag = Math.max(2, Math.floor(this.rate / MAX_FREQ))
    const maxLag = Math.min(this.nsdf.length - 1, Math.floor(this.rate / MIN_FREQ))
    const x = this.decimated

    for (let tau = minLag; tau <= maxLag; tau++) {
      let ac = 0
      let m = 0
      const n = WINDOW - tau
      for (let i = 0; i < n; i++) {
        const a = x[i]
        const b = x[i + tau]
        ac += a * b
        m += a * a + b * b
      }
      this.nsdf[tau] = m > 0 ? (2 * ac) / m : 0
    }

    // Walk off the zero-lag lobe first, then take the maximum of each
    // positive lobe as a candidate period.
    let i = minLag
    while (i <= maxLag && this.nsdf[i] > 0) i++
    let best = -1
    let bestVal = 0
    const peaks: number[] = []
    while (i <= maxLag) {
      if (this.nsdf[i] <= 0) {
        i++
        continue
      }
      let top = i
      while (i <= maxLag && this.nsdf[i] > 0) {
        if (this.nsdf[i] > this.nsdf[top]) top = i
        i++
      }
      peaks.push(top)
      if (this.nsdf[top] > bestVal) {
        bestVal = this.nsdf[top]
        best = top
      }
    }

    if (best < 0 || bestVal < MIN_CLARITY) {
      this.history = []
      this.onVoice({ freq: 0, midi: 0, cents: 0, clarity: bestVal, level })
      return
    }

    let chosen = best
    for (const p of peaks) {
      if (this.nsdf[p] >= bestVal * PEAK_TOLERANCE) {
        chosen = p
        break
      }
    }

    // Sub-sample the peak. A whole-sample period at 8kHz is 25 cents wide up
    // at the top of the range, which would make the needle useless.
    const lag = chosen + parabolic(this.nsdf, chosen)
    const freq = this.rate / lag
    if (!isFinite(freq) || freq < MIN_FREQ || freq > MAX_FREQ) {
      this.onVoice({ freq: 0, midi: 0, cents: 0, clarity: bestVal, level })
      return
    }

    // A median over the last handful of readings. Individual frames still slip
    // an octave occasionally — a breath, a consonant — and a median throws
    // those away without adding the lag that averaging would.
    this.history.push(freq)
    if (this.history.length > 5) this.history.shift()
    const stable = median(this.history)

    const exact = freqToMidi(stable, this.a4)
    const midi = Math.round(exact)
    this.onVoice({
      freq: stable,
      midi,
      cents: (exact - midi) * 100,
      clarity: bestVal,
      level,
    })
  }

  // --- the whole chord ----------------------------------------------------

  /**
   * How far each part is from where it should be, relative to the chord as it
   * is actually being sung.
   *
   * The measurement itself lives in `chord.ts`; what happens here is the
   * plumbing. The analyser hands out decibels, everything downstream wants
   * linear magnitude against a local background, and the plan of which
   * harmonics to measure each part at depends only on the chord's intervals —
   * so it is worked out when the chord changes rather than thirty times a
   * second.
   */
  private readChord() {
    const analyser = this.specAnalyser
    if (!analyser || !this.ctx) return
    analyser.getFloatFrequencyData(this.freqBuf)

    const mag = this.spectrum.mag
    for (let i = 0; i < mag.length; i++) {
      const db = this.freqBuf[i]
      // -Infinity is a real value here: an empty bin logs to nothing.
      mag[i] = isFinite(db) ? Math.pow(10, db / 20) : 0
    }
    this.floor.measure(this.spectrum, this.floorScratch)

    const freqs = this.targets.map((t) => t.freq)
    if (!sameFreqs(freqs, this.planned)) {
      this.plans = planChord(freqs)
      this.planned = freqs
      this.tracker.reset()
    }

    const alignment = alignChord(this.spectrum, freqs, this.floor, this.tracker.lastShift)
    const measured = measureChord(this.spectrum, freqs, this.plans, this.floor, alignment)
    this.onChord(this.tracker.update(measured, performance.now()))
  }
}

/** Whether the chord under the microphone is still the same chord. */
function sameFreqs(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > 1e-6) return false
  }
  return true
}

function errorText(kind?: MicErrorKind): string {
  if (kind === 'unsupported') return 'This browser can’t reach the microphone.'
  return 'Could not open the microphone.'
}

/**
 * Offset of the true peak from sample `i`, by fitting a parabola through it and
 * its neighbours. Returns 0 when the three points don't describe a peak.
 *
 * Linear, unlike the spectral one in `spectrum.ts`, which fits in the log
 * domain because that is where a windowed FFT's peak is actually a parabola.
 * This one fits the correlation function, which is already the right shape.
 */
function parabolic(buf: Float32Array, i: number): number {
  if (i <= 0 || i >= buf.length - 1) return 0
  const a = buf[i - 1]
  const b = buf[i]
  const c = buf[i + 1]
  if (!isFinite(a) || !isFinite(b) || !isFinite(c)) return 0
  const denom = a - 2 * b + c
  if (denom === 0) return 0
  const d = (0.5 * (a - c)) / denom
  return Math.abs(d) < 1 ? d : 0
}

function median(values: number[]): number {
  const s = values.slice().sort((x, y) => x - y)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function nextPow2(n: number): number {
  let p = 32
  while (p < n) p *= 2
  return Math.min(32768, p)
}
