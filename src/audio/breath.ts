/**
 * Breath input.
 *
 * You blow at your phone and the pipe sounds — harder breath, louder and
 * brighter tone, exactly like the real thing. This is the party trick, and it
 * lives or dies on not false-triggering.
 *
 * The hard part isn't detecting loudness, it's telling *blowing* apart from
 * everything else the mic hears: forty people singing, a director talking, and
 * the app's own tone coming back out of the speaker. Breath is broadband noise;
 * voices and our own reed are harmonic. So the gate is energy plus a measure of
 * how noise-like the spectrum is — see `noisiness()` for why that measure is
 * taken per sub-band rather than across the whole range, which is the
 * difference between this working on a phone and not.
 *
 * A loud direct puff opens the gate regardless, because microphone responses
 * vary too much between devices to bet the whole feature on the spectrum
 * looking the way we expect.
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
  noisiness: number
  /** True while the gate is open — i.e. we believe you are blowing. */
  blowing: boolean
  /** Current gate threshold, so the meter can draw the trigger line. */
  threshold: number
}

/**
 * Gate bars for the noisiness measure below. These are set from measurement,
 * not taste: breath scores 0.44-0.69, a single sung note 0.10-0.15, room tone
 * high but rejected on level instead. The bar sits in the gap with room to
 * spare at both ends.
 *
 * Known limit: a full chorus scores ~0.60 — that many detuned harmonics
 * genuinely do fill every band, so no spectral measure can tell them from
 * broadband noise. Proximity is what saves us in practice, since a puff at the
 * microphone dwarfs a section singing several metres away. If it ever does
 * misfire mid-song, press-and-hold still works with breath mode off.
 */
const NOISE_OPEN = 0.34
/** Once open, we hang on looser to avoid chattering mid-breath. */
const NOISE_HOLD = 0.24

/**
 * A puff this far above the noise floor opens the gate on a much weaker
 * noisiness bar. The safety net: microphone responses vary enormously across
 * phones, and a feature that silently never triggers is worse than one that
 * occasionally triggers early. It still refuses anything clearly harmonic, and
 * it only applies while the pipe is silent, so our own speaker can't trip it.
 */
const LOUD_PUFF_RATIO = 2.2
const LOUD_PUFF_NOISE = 0.28

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

    const noisiness = this.noisiness()

    // --- calibration -----------------------------------------------------
    const now = performance.now()
    if (now < this.calibrationUntil) {
      this.calibrationSamples.push(energy)
      this.onFrame({
        pressure: 0,
        energy,
        noisiness,
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
    // Turning sensitivity up relaxes what counts as breath as well as how
    // loud it must be, otherwise the slider can't rescue a microphone whose
    // spectrum simply doesn't look the way we expect.
    const relax = this.sensitivity * 0.1

    if (this.gateOpen) {
      this.gateOpen =
        noisiness > NOISE_HOLD - relax && energy > threshold * 0.55
    } else {
      const looksLikeBreath = noisiness > NOISE_OPEN - relax
      // The safety net. Only reachable while the pipe is silent, so our own
      // output can never trip it, and still barred to anything clearly tonal.
      const unmistakablePuff =
        energy > threshold * LOUD_PUFF_RATIO &&
        noisiness > LOUD_PUFF_NOISE - relax
      this.gateOpen = energy > threshold && (looksLikeBreath || unmistakablePuff)
    }

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
      noisiness,
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
   * How noise-like the spectrum is. 1 = broadband hiss, 0 = a pure tone.
   *
   * This is Wiener entropy (geometric mean over arithmetic mean of the power
   * spectrum), but computed per sub-band and then taken as a median rather
   * than once across the whole range. That difference matters a lot in
   * practice: plain wideband flatness also punishes spectral *tilt*, and
   * breath through a phone microphone is extremely tilted — so real breath
   * scored as "tonal" and the gate never opened. Within a narrow band there
   * is little tilt left to punish, so each sub-band score reflects only
   * noisiness, and the median ignores a band or two dominated by a stray tone.
   */
  private noisiness(): number {
    if (!this.ctx || !this.analyser) return 0
    const nyquist = this.ctx.sampleRate / 2
    const binHz = nyquist / this.freqBuf.length
    const BANDS = 8
    const LO = 300
    const HI = 8000
    const ratio = Math.pow(HI / LO, 1 / BANDS)

    const flat: number[] = []
    const power: number[] = []
    let f0 = LO
    for (let b = 0; b < BANDS; b++) {
      const f1 = f0 * ratio
      const i0 = Math.max(1, Math.floor(f0 / binHz))
      const i1 = Math.min(this.freqBuf.length - 1, Math.floor(f1 / binHz))
      f0 = f1
      // Too few bins to say anything meaningful about the shape.
      if (i1 - i0 < 3) continue

      let logSum = 0
      let linSum = 0
      let n = 0
      for (let i = i0; i <= i1; i++) {
        // getFloatFrequencyData is dB; back to power, with a floor so silent
        // bins don't drag the geometric mean to zero.
        const p = Math.pow(10, this.freqBuf[i] / 10) + 1e-12
        logSum += Math.log(p)
        linSum += p
        n++
      }
      flat.push(Math.exp(logSum / n) / (linSum / n))
      power.push(linSum)
    }
    if (!flat.length) return 0

    // Score only the bands actually carrying energy, and take a low quantile
    // of those rather than the middle. Breath is noisy in every band it
    // occupies, so its weakest band still scores high. A tone is peaky
    // wherever its harmonics land, so *some* energetic band scores low even
    // though the empty bands above it look like pure noise — which is exactly
    // how a low sung note used to sneak past a median.
    const loudest = Math.max(...power)
    const scored = flat.filter((_, i) => power[i] > loudest * 0.05)
    const use = scored.length ? scored : flat
    use.sort((a, b) => a - b)
    return Math.min(1, use[Math.floor(use.length * 0.25)])
  }
}
