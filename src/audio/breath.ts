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

import {
  closeMicrophone,
  isAppleMobile,
  listAudioInputs,
  openMicrophone,
} from './mic'

export { prefersPuffMode } from './mic'

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
  /**
   * True while the note is being carried through a gap in the breath rather
   * than driven by it. The meter dims instead of going cold, so a held note
   * with no visible input still looks deliberate.
   */
  sustaining: boolean
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

/**
 * Clamps, deliberately far below any real microphone's self-noise.
 *
 * These only exist to stop a stream reporting digital silence from driving the
 * trigger to zero. They are emphatically *not* a sensitivity control: an
 * absolute floor set anywhere near real signal levels overrides the room
 * measurement in a quiet hall, and then the trigger sits at some fixed loudness
 * that has nothing to do with the room — which is what made blowing so hard.
 * Sensitivity belongs entirely to the multiple-of-the-room in threshold().
 */
const NOISE_FLOOR_MIN = 0.00005
const ABSOLUTE_MIN = 0.00012

const CALIBRATION_MS = 900

/**
 * Grace period after the microphone starts or unmutes, during which the gate
 * stays shut.
 *
 * A freshly opened capture track delivers a burst of nonsense in its first
 * frames — filters settling, gain ramping, a click as the route changes. That
 * burst is loud and broadband, which is precisely what breath looks like, so
 * without this the pipe retriggers itself the instant it re-arms and loops
 * forever. Happens on every platform; it is simply most destructive where
 * re-arming means acquiring the device again.
 */
const ARM_SETTLE_MS = 400

/**
 * Shorter room measurement when re-arming between notes.
 *
 * Re-measuring at all might look wasteful when the room was measured seconds
 * ago, but releasing and re-acquiring the microphone can come back with a
 * different input gain — iOS changes the audio route along with the session
 * category — and a noise floor recorded under the old gain describes nothing.
 */
const REARM_CALIBRATION_MS = 420

/**
 * How long the reed keeps speaking after the breath stops, at the two ends of
 * the smoothing control.
 *
 * Nobody blows a perfectly steady stream at a phone. Breath breaks for a
 * moment when you re-set your mouth, when you turn your head, when a consonant
 * gets in the way — and a gate with no memory turns every one of those into the
 * note being switched off and on again. So when the gate closes, the pressure
 * is *held* for a moment and allowed to sag rather than being dropped: a gap
 * shorter than the hang reads as the reed coasting, which is what a real reed
 * does, and only a real stop actually stops it.
 *
 * The floor is deliberately not zero. Even at the crispest setting a couple of
 * frames of hang costs nothing and removes the buzzing that a gate sitting
 * exactly on its threshold otherwise produces.
 */
const HANG_MIN_MS = 60
const HANG_MAX_MS = 460
/** Fraction of the held pressure still left at the end of the hang. */
const HANG_SAG = 0.45

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
  private calibrationFrom = 0
  private calibrated = false
  private paused = false
  private armedAt = 0
  /**
   * Set whenever listening (re)starts. The gate cannot open until the input
   * has been observed genuinely quiet at least once, so whatever is still
   * making noise at the moment we start — a decaying chord, a route-change
   * click, a settling gain stage — cannot be read as a fresh breath.
   */
  private needsQuiet = false
  private quietFrames = 0
  /**
   * Whether pausing should fully release the microphone or merely mute it.
   * Resolved once, from platform capability rather than a guess — see
   * `resolveReleaseStrategy`.
   */
  private hardRelease = false
  private strategyResolved = false

  /** Pressure at the moment the gate last closed, and when that was. */
  private heldPressure = 0
  private closedAt = 0

  /** User-facing sensitivity, 0..1. Higher = easier to trigger. */
  sensitivity = 0.65

  /**
   * User-facing smoothing, 0..1. Higher rides through longer gaps in the
   * breath and falls away more gently; lower tracks every flicker.
   */
  smoothing = 0.45

  /** Preferred input device, if the person has picked one. */
  deviceId: string | null = null

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

    this.setStatus('requesting')

    const result = await openMicrophone(this.deviceId)
    if (!result.stream) {
      if (result.kind === 'denied') this.setStatus('denied')
      else if (result.kind === 'unsupported') {
        this.setStatus('unsupported', result.detail)
      } else this.setStatus('error', result.detail)
      return false
    }
    this.stream = result.stream

    this.ctx = context
    this.source = context.createMediaStreamSource(this.stream)
    this.analyser = context.createAnalyser()
    // 4096 rather than 1024, because resolution decides whether a voice reads
    // as harmonic. At 1024 the bins are ~47 Hz apart while a low male voice
    // puts harmonics every ~130 Hz — under three bins — so the spectrum looks
    // continuous rather than peaky and speech scored as breath. At 4096 the
    // bins are ~12 Hz and the harmonics stand clear of the gaps between them.
    this.analyser.fftSize = 4096
    this.analyser.smoothingTimeConstant = 0.15
    this.source.connect(this.analyser)
    // Deliberately not connected to the destination — routing the mic to the
    // speakers in a room full of singers would be a feedback disaster.

    this.timeBuf = new Float32Array(this.analyser.fftSize)
    this.freqBuf = new Float32Array(this.analyser.frequencyBinCount)

    this.smoothed = 0
    this.gateOpen = false
    this.paused = false
    this.heldPressure = 0
    this.closedAt = 0
    this.armedAt = performance.now()
    void this.resolveReleaseStrategy()
    this.calibrationSamples = []
    // Measurement starts only once the input has settled; averaging in the
    // start-up transient would set the noise floor from a burst of garbage and
    // leave the trigger unreachable.
    this.calibrationFrom = performance.now() + ARM_SETTLE_MS
    this.calibrationUntil =
      this.calibrationFrom +
      (this.calibrated ? REARM_CALIBRATION_MS : CALIBRATION_MS)
    this.needsQuiet = true
    this.setStatus(this.calibrated ? 'listening' : 'calibrating')
    this.loop()
    return true
  }

  /**
   * Input devices to choose from. Labels only exist once permission has been
   * granted, so this is worth calling after the microphone is already open.
   */
  static listInputs = listAudioInputs

  stop() {
    cancelAnimationFrame(this.raf)
    this.raf = 0
    this.source?.disconnect()
    this.source = null
    this.analyser = null
    if (this.stream) closeMicrophone(this.stream)
    this.stream = null
    this.gateOpen = false
    this.paused = false
    this.heldPressure = 0
    this.closedAt = 0
    this.setStatus('idle')
  }

  /**
   * Decide how to pause between notes.
   *
   * Two platforms want opposite things. Apple's mobile browsers hold playback
   * quiet for as long as a capture track is live, so the track has to go away
   * entirely. Firefox, meanwhile, grants microphone access for one use unless
   * the person ticked "Remember", so re-acquiring can raise a fresh permission
   * prompt — once per puff would be intolerable.
   *
   * So: release fully where an open microphone actually costs something, or
   * where the browser can confirm the grant is persistent and re-acquiring is
   * therefore silent. Otherwise keep the track and just mute it, which is
   * instant everywhere and can never prompt.
   */
  private async resolveReleaseStrategy() {
    if (this.strategyResolved) return
    this.strategyResolved = true

    if (isAppleMobile()) {
      this.hardRelease = true
      return
    }
    try {
      const status = await navigator.permissions?.query({
        name: 'microphone' as PermissionName,
      })
      this.hardRelease = status?.state === 'granted'
    } catch {
      // Firefox has historically thrown for the microphone permission name.
      // Not knowing means not risking a prompt.
      this.hardRelease = false
    }
  }

  /**
   * Stop listening while a note sounds, by whichever route this platform
   * needs. Muting still stops the analysis, so a ringing pipe can never be
   * mistaken for a breath.
   */
  pause() {
    if (this.hardRelease) {
      this.stop()
      return
    }
    this.paused = true
    this.stream?.getTracks().forEach((t) => (t.enabled = false))
  }

  /** Start listening again after a note. Safe to call when already live. */
  resume(context: AudioContext) {
    if (this.stream && this.paused) {
      this.paused = false
      this.armedAt = performance.now()
      this.needsQuiet = true
      this.quietFrames = 0
      this.heldPressure = 0
      this.closedAt = 0
      this.stream.getTracks().forEach((t) => (t.enabled = true))
      this.setStatus('listening')
      return
    }
    if (!this.stream) void this.start(context)
  }

  /** Re-measure the room. Worth doing when you move to a noisier hall. */
  recalibrate() {
    this.calibrated = false
    if (!this.stream) return
    this.calibrationSamples = []
    this.calibrationUntil = performance.now() + CALIBRATION_MS
    this.setStatus('calibrating')
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop)
    const analyser = this.analyser
    if (!analyser || !this.ctx) return
    // Muted between notes. Bailing out before anything is measured matters:
    // a muted track delivers digital silence, and letting the room tracker
    // see that would drag the noise floor to nothing and leave the gate on a
    // hair trigger the moment we unmute.
    if (this.paused) return

    analyser.getFloatTimeDomainData(this.timeBuf)
    analyser.getFloatFrequencyData(this.freqBuf)

    // Broadband level, over the most recent ~20ms only. The FFT window is much
    // longer than that for the sake of frequency resolution, but averaging
    // loudness across 85ms would blunt the attack of a puff.
    const window = Math.min(1024, this.timeBuf.length)
    let sum = 0
    for (let i = this.timeBuf.length - window; i < this.timeBuf.length; i++) {
      sum += this.timeBuf[i] * this.timeBuf[i]
    }
    const energy = Math.sqrt(sum / window)

    const noisiness = this.noisiness()

    // --- calibration -----------------------------------------------------
    const now = performance.now()
    if (now < this.calibrationUntil) {
      if (now >= this.calibrationFrom) this.calibrationSamples.push(energy)
      this.onFrame({
        pressure: 0,
        energy,
        noisiness,
        blowing: false,
        sustaining: false,
        threshold: this.threshold(),
      })
      return
    }
    if (this.calibrationSamples.length) {
      // 90th percentile rather than the max, so one cough during calibration
      // doesn't leave the gate permanently unreachable.
      const sorted = this.calibrationSamples.slice().sort((a, b) => a - b)
      const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? 0.004
      this.noiseFloor = Math.max(NOISE_FLOOR_MIN, p90)
      this.ceiling = Math.max(this.noiseFloor * 8, 0.04)
      this.calibrationSamples = []
      this.calibrated = true
      this.setStatus('listening')
    }

    // Keep tracking the room rather than trusting one measurement forever.
    // Falls fast and rises slowly, so a quiet hall pulls the trigger point
    // down with it — a floor measured once during a noisy moment was a large
    // part of why blowing had to be so hard.
    if (!this.gateOpen) {
      const k = energy < this.noiseFloor ? 0.25 : 0.0009
      this.noiseFloor = Math.max(
        NOISE_FLOOR_MIN,
        this.noiseFloor + (energy - this.noiseFloor) * k,
      )
    }

    // --- gate ------------------------------------------------------------
    const threshold = this.threshold()

    if (now - this.armedAt < ARM_SETTLE_MS) {
      this.gateOpen = false
      this.smoothed = 0
      this.heldPressure = 0
      this.onFrame({
        pressure: 0,
        energy,
        noisiness,
        blowing: false,
        sustaining: false,
        threshold,
      })
      return
    }

    // Require the input to fall quiet once before it may trigger again. This
    // is what stops a note from replaying the moment it ends: whatever is
    // still making noise when we resume — the chord's own tail, the click of
    // an audio route changing back, a gain stage settling — has to subside
    // before a breath can be recognised. It cannot deadlock, because the room
    // is re-measured on every arm, so "quiet" always means quiet *for here*.
    if (this.needsQuiet) {
      this.quietFrames = energy < threshold * 0.8 ? this.quietFrames + 1 : 0
      if (this.quietFrames >= 4) {
        this.needsQuiet = false
      } else {
        this.gateOpen = false
        this.smoothed = 0
        this.heldPressure = 0
        this.onFrame({
          pressure: 0,
          energy,
          noisiness,
          blowing: false,
          sustaining: false,
          threshold,
        })
        return
      }
    }
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
    let sustaining = false
    if (this.gateOpen) {
      const span = Math.max(1e-6, this.ceiling - threshold * 0.55)
      target = Math.min(1, Math.max(0, (energy - threshold * 0.55) / span))
      this.heldPressure = target
      this.closedAt = 0
    } else if (this.heldPressure > 0) {
      // The gate has just shut. Carry the note rather than cutting it: hold
      // the pressure it was last driven at and let it sag, so a breath that
      // breaks for a moment sounds like a reed coasting instead of a switch
      // being flicked. Bounded, so a real stop still stops.
      if (this.closedAt === 0) this.closedAt = now
      const hang = HANG_MIN_MS + (HANG_MAX_MS - HANG_MIN_MS) * this.smoothing
      const elapsed = now - this.closedAt
      if (elapsed < hang) {
        target = this.heldPressure * (1 - HANG_SAG * (elapsed / hang))
        sustaining = true
      } else {
        this.heldPressure = 0
      }
    }

    // Asymmetric: quick to respond, slower to fall away, which is both how a
    // reed behaves and forgiving of the moment-to-moment unevenness of real
    // breath. The fall is what the smoothing control mostly moves — past the
    // hang, this is the difference between a note that stops and one that
    // fades.
    const rise = 0.5 - 0.12 * this.smoothing
    const fall = 0.3 - 0.2 * this.smoothing
    this.smoothed += (target - this.smoothed) * (target > this.smoothed ? rise : fall)
    if (this.smoothed < 0.002) this.smoothed = 0

    this.onFrame({
      pressure: this.smoothed,
      energy,
      noisiness,
      blowing: this.gateOpen,
      sustaining: sustaining && this.smoothed > 0,
      threshold,
    })
  }

  private threshold(): number {
    // sensitivity 0 -> 5x the room (needs a real puff), 1 -> 1.8x (hair
    // trigger). The absolute floor is only a backstop against a microphone
    // reporting implausible silence; the room measurement normally dominates.
    const mult = 5 - this.sensitivity * 3.2
    return Math.max(ABSOLUTE_MIN, this.noiseFloor * mult)
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
    // Clamped to what the stream can actually carry. A phone-call headset
    // running narrowband has nothing above ~4 kHz, and analysing empty
    // spectrum as though it were signal tells us nothing.
    const HI = Math.min(8000, nyquist * 0.92)
    if (HI <= LO * 2) return 0
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
      // Mean per bin, not the total. The bands are log-spaced, so the top one
      // spans a dozen times as many bins as the bottom one; ranking them by
      // total power let a wide, quiet, harmonic-free band outrank a narrow one
      // carrying a loud harmonic — and then the statistic was computed over
      // exactly the bands with no harmonics in them, which is how a speaking
      // voice scored as breath.
      power.push(linSum / n)
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
