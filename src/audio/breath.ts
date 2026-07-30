/**
 * Breath input.
 *
 * You blow at your phone and the pipe sounds — harder breath, louder and
 * brighter tone, exactly like the real thing. This is the party trick, and it
 * lives or dies on not false-triggering.
 *
 * The hard part isn't detecting loudness, it's telling *blowing* apart from
 * everything else the mic hears: forty people singing, a director talking, and
 * the app's own tone coming back out of the speaker. The trick is spectral
 * flatness. Breath is broadband noise (flat spectrum). Voices and our own reed
 * are harmonic (peaky spectrum). Energy alone can't distinguish them; energy
 * plus flatness separates them cleanly.
 */

import { setAudioSessionType } from './engine'

export type BreathStatus =
  | 'idle'
  | 'requesting'
  | 'calibrating'
  | 'listening'
  | 'denied'
  | 'unsupported'
  | 'error'

export interface BreathFrame {
  /** 0..1 drive for the reed. Zero when the gate is shut. */
  pressure: number
  /** Raw broadband level, for the meter. */
  energy: number
  /** 0..1. High = noise-like (breath). Low = tonal (voice, or our speaker). */
  flatness: number
  /** True while the gate is open — i.e. we believe you are blowing. */
  blowing: boolean
  /** Current gate threshold, so the meter can draw the trigger line. */
  threshold: number
}

/** Gate opens only above this. Voices and speaker bleed sit well below. */
const FLATNESS_OPEN = 0.16
/** Once open, we hang on a little looser to avoid chattering mid-breath. */
const FLATNESS_HOLD = 0.1

const CALIBRATION_MS = 900

export class BreathDetector {
  private stream: MediaStream | null = null
  private ctx: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private analyser: AnalyserNode | null = null
  private timeBuf = new Float32Array(0)
  private freqBuf = new Float32Array(0)
  private raf = 0

  private noiseFloor = 0.004
  private ceiling = 0.05
  private smoothed = 0
  private gateOpen = false
  private calibrationSamples: number[] = []
  private calibrationUntil = 0

  /** User-facing sensitivity, 0..1. Higher = easier to trigger. */
  sensitivity = 0.5

  status: BreathStatus = 'idle'

  constructor(
    private onFrame: (f: BreathFrame) => void,
    private onStatus: (s: BreathStatus, detail?: string) => void,
  ) {}

  private setStatus(s: BreathStatus, detail?: string) {
    this.status = s
    this.onStatus(s, detail)
  }

  async start(context: AudioContext): Promise<boolean> {
    if (this.stream) return true

    if (!navigator.mediaDevices?.getUserMedia) {
      this.setStatus(
        'unsupported',
        window.isSecureContext === false
          ? 'Microphone needs a secure (https) connection.'
          : 'This browser has no microphone access.',
      )
      return false
    }

    this.setStatus('requesting')

    // Safari will not open the microphone while the page's audio session is
    // declared playback-only, which is how we start up so the ringer switch
    // can't silence the pipe. Move it before asking.
    setAudioSessionType('play-and-record')

    // Every one of these processors is designed to remove exactly the signal
    // we want: noise suppression will happily erase breath as "background
    // noise", and AGC fights the pressure mapping. Safari is fussier about
    // audio constraints than Chrome and fails the whole call over one it
    // dislikes, so ask for the ideal setup and walk down from there.
    const attempts: MediaStreamConstraints[] = [
      {
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      },
      {
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      },
      { audio: true },
    ]

    let lastError: unknown = null
    for (const constraints of attempts) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia(constraints)
        break
      } catch (err) {
        lastError = err
        // A refusal is final. Retrying just re-prompts for something the
        // person has already declined.
        const name = (err as DOMException)?.name
        if (name === 'NotAllowedError' || name === 'SecurityError') break
      }
    }

    if (!this.stream) {
      setAudioSessionType('playback')
      const name = (lastError as DOMException)?.name ?? ''
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        this.setStatus('denied')
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        this.setStatus('error', 'No microphone found on this device.')
      } else if (name === 'NotReadableError' || name === 'TrackStartError') {
        this.setStatus('error', 'Another app is holding the microphone.')
      } else {
        // Surface whatever the browser actually said. A generic "unavailable"
        // is impossible to act on and impossible to debug remotely.
        const msg = (lastError as Error)?.message
        this.setStatus(
          'error',
          [name, msg].filter(Boolean).join(': ') || 'Could not open the microphone.',
        )
      }
      return false
    }

    this.ctx = context
    this.source = context.createMediaStreamSource(this.stream)
    this.analyser = context.createAnalyser()
    this.analyser.fftSize = 1024
    this.analyser.smoothingTimeConstant = 0.15
    this.source.connect(this.analyser)
    // Deliberately not connected to the destination — routing the mic to the
    // speakers in a room full of singers would be a feedback disaster.

    this.timeBuf = new Float32Array(this.analyser.fftSize)
    this.freqBuf = new Float32Array(this.analyser.frequencyBinCount)

    this.calibrationSamples = []
    this.calibrationUntil = performance.now() + CALIBRATION_MS
    this.smoothed = 0
    this.gateOpen = false
    this.setStatus('calibrating')
    this.loop()
    return true
  }

  stop() {
    cancelAnimationFrame(this.raf)
    this.raf = 0
    this.source?.disconnect()
    this.source = null
    this.analyser = null
    // Releasing the tracks is what clears the browser's recording indicator.
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.gateOpen = false
    // Back to playback-only, so the ringer switch stops mattering again.
    setAudioSessionType('playback')
    this.setStatus('idle')
  }

  /** Re-measure the room. Worth doing when you move to a noisier hall. */
  recalibrate() {
    if (!this.stream) return
    this.calibrationSamples = []
    this.calibrationUntil = performance.now() + CALIBRATION_MS
    this.setStatus('calibrating')
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop)
    const analyser = this.analyser
    if (!analyser || !this.ctx) return

    analyser.getFloatTimeDomainData(this.timeBuf)
    analyser.getFloatFrequencyData(this.freqBuf)

    // Broadband level.
    let sum = 0
    for (let i = 0; i < this.timeBuf.length; i++) {
      sum += this.timeBuf[i] * this.timeBuf[i]
    }
    const energy = Math.sqrt(sum / this.timeBuf.length)

    const flatness = this.spectralFlatness()

    // --- calibration -----------------------------------------------------
    const now = performance.now()
    if (now < this.calibrationUntil) {
      this.calibrationSamples.push(energy)
      this.onFrame({
        pressure: 0,
        energy,
        flatness,
        blowing: false,
        threshold: this.threshold(),
      })
      return
    }
    if (this.calibrationSamples.length) {
      // 90th percentile rather than the max, so one cough during calibration
      // doesn't leave the gate permanently unreachable.
      const sorted = this.calibrationSamples.slice().sort((a, b) => a - b)
      const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? 0.004
      this.noiseFloor = Math.max(0.0015, p90)
      this.ceiling = Math.max(this.noiseFloor * 8, 0.04)
      this.calibrationSamples = []
      this.setStatus('listening')
    }

    // --- gate ------------------------------------------------------------
    const threshold = this.threshold()
    const flatEnough = this.gateOpen
      ? flatness > FLATNESS_HOLD
      : flatness > FLATNESS_OPEN
    const loudEnough = this.gateOpen
      ? energy > threshold * 0.55
      : energy > threshold
    this.gateOpen = flatEnough && loudEnough

    // --- pressure --------------------------------------------------------
    // The ceiling adapts to how hard this particular person actually blows,
    // so a gentle breather still reaches full volume.
    if (this.gateOpen && energy > this.ceiling) {
      this.ceiling = energy
    } else {
      this.ceiling = Math.max(threshold * 2.2, this.ceiling * 0.9995)
    }

    let target = 0
    if (this.gateOpen) {
      const span = Math.max(1e-6, this.ceiling - threshold * 0.55)
      target = Math.min(1, Math.max(0, (energy - threshold * 0.55) / span))
    }

    // Asymmetric smoothing: quick to respond, slower to fall away, which is
    // both how a reed behaves and forgiving of momentary dropouts.
    const coeff = target > this.smoothed ? 0.45 : 0.16
    this.smoothed += (target - this.smoothed) * coeff
    if (this.smoothed < 0.002) this.smoothed = 0

    this.onFrame({
      pressure: this.smoothed,
      energy,
      flatness,
      blowing: this.gateOpen,
      threshold,
    })
  }

  private threshold(): number {
    // sensitivity 0 -> 6x noise floor (deaf), 1 -> 1.6x (hair trigger)
    const mult = 6 - this.sensitivity * 4.4
    return Math.max(0.006, this.noiseFloor * mult)
  }

  /**
   * Wiener entropy over the speech/breath band: geometric mean over arithmetic
   * mean of the power spectrum. 1 = white noise, 0 = pure tone.
   */
  private spectralFlatness(): number {
    if (!this.ctx || !this.analyser) return 0
    const nyquist = this.ctx.sampleRate / 2
    const binHz = nyquist / this.freqBuf.length
    const lo = Math.floor(300 / binHz)
    const hi = Math.min(this.freqBuf.length - 1, Math.floor(8000 / binHz))
    if (hi <= lo) return 0

    let logSum = 0
    let linSum = 0
    let n = 0
    for (let i = lo; i <= hi; i++) {
      // getFloatFrequencyData is dB; back to power, with a floor so silent
      // bins don't drag the geometric mean to zero.
      const power = Math.pow(10, this.freqBuf[i] / 10) + 1e-12
      logSum += Math.log(power)
      linSum += power
      n++
    }
    const geo = Math.exp(logSum / n)
    const arith = linSum / n
    return arith > 0 ? Math.min(1, geo / arith) : 0
  }
}
