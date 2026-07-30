/**
 * The sound engine.
 *
 * Every other pitch pipe on the web is `osc.type = 'sine'`. A real pitch pipe
 * is a free reed: it has a breathy chiff on the attack, it bends up in pitch as
 * air pressure builds, it sits on a bed of air noise, and it sags flat as the
 * breath dies. All of that is modelled here, because it's the difference
 * between an app that sounds like a hearing test and one that sounds like an
 * instrument.
 */

// ---------------------------------------------------------------------------
// Context + master chain
// ---------------------------------------------------------------------------

let ctx: AudioContext | null = null
let master: MasterChain | null = null

interface MasterChain {
  /** Where voices connect. */
  bus: GainNode
  /**
   * Mechanical noises go straight out, skipping hall processing — a detent
   * click that got saturated and compressed alongside the tone would be
   * absurdly loud. It still tracks the volume slider, though.
   */
  clickBus: GainNode
  highpass: BiquadFilterNode
  dry: GainNode
  wet: GainNode
  presence: BiquadFilterNode
  comp: DynamicsCompressorNode
  makeup: GainNode
  analyser: AnalyserNode
}

/**
 * Soft asymmetric saturation. Adds upper harmonics so the pitch still reads on
 * a phone speaker that physically cannot reproduce a 175 Hz fundamental — the
 * ear reconstructs the missing fundamental from the harmonics above it.
 */
function makeDriveCurve(amount = 0.7): Float32Array<ArrayBuffer> {
  const n = 2048
  const curve = new Float32Array(new ArrayBuffer(n * 4))
  const k = amount * 40
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x))
  }
  return curve
}

function buildMaster(context: AudioContext): MasterChain {
  const bus = context.createGain()
  bus.gain.value = 0.9

  const clickBus = context.createGain()
  clickBus.gain.value = 0.9
  clickBus.connect(context.destination)

  const highpass = context.createBiquadFilter()
  highpass.type = 'highpass'
  highpass.frequency.value = 60
  highpass.Q.value = 0.7

  const shaper = context.createWaveShaper()
  shaper.curve = makeDriveCurve(0.7)
  shaper.oversample = '2x'

  const dry = context.createGain()
  dry.gain.value = 1
  const wet = context.createGain()
  wet.gain.value = 0

  const presence = context.createBiquadFilter()
  presence.type = 'peaking'
  presence.frequency.value = 2500
  presence.Q.value = 0.9
  presence.gain.value = 0

  const comp = context.createDynamicsCompressor()
  comp.threshold.value = -12
  comp.knee.value = 10
  comp.ratio.value = 3
  comp.attack.value = 0.005
  comp.release.value = 0.16

  const makeup = context.createGain()
  makeup.gain.value = 1

  // A real limiter on the very end so nothing ever clips, whatever the user
  // stacks up (four-part chord + hall mode + max volume).
  const limiter = context.createDynamicsCompressor()
  limiter.threshold.value = -2
  limiter.knee.value = 0
  limiter.ratio.value = 20
  limiter.attack.value = 0.002
  limiter.release.value = 0.06

  // Tapped pre-limiter so the visual glow tracks what the synth is doing
  // rather than what the limiter has flattened.
  const analyser = context.createAnalyser()
  analyser.fftSize = 1024
  analyser.smoothingTimeConstant = 0.6

  bus.connect(highpass)
  highpass.connect(dry)
  highpass.connect(shaper)
  shaper.connect(wet)
  dry.connect(presence)
  wet.connect(presence)
  presence.connect(comp)
  comp.connect(makeup)
  makeup.connect(analyser)
  makeup.connect(limiter)
  limiter.connect(context.destination)

  return { bus, clickBus, highpass, dry, wet, presence, comp, makeup, analyser }
}

/**
 * Declare what this page does with audio.
 *
 * iOS Safari maps this onto an AVAudioSession category. "playback" is what we
 * want almost all of the time: it means the ringer switch can't silence the
 * pipe, which matters when a director is on stage with a phone on silent.
 *
 * But "playback" also declares that the page will *not* record — so while it
 * is set, Safari refuses to hand over the microphone. Breath mode has to move
 * the session to "play-and-record" first, and put it back afterwards.
 */
export type AudioSessionType = 'playback' | 'play-and-record'

export function setAudioSessionType(type: AudioSessionType) {
  const session = (navigator as unknown as { audioSession?: { type: string } })
    .audioSession
  if (!session) return
  try {
    session.type = type
  } catch {
    /* not fatal — older WebKit has no audio session API at all */
  }
}

/**
 * Get the audio context, creating it if needed, without awaiting.
 *
 * Safari grants a user gesture a short window in which privileged calls are
 * allowed, and every `await` risks spending it. Callers that are about to do
 * something gated — `getUserMedia` above all — should use this and let the
 * gated call be the first await in the chain.
 */
export function getAudio(): AudioContext {
  if (!ctx) {
    const Ctor: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext
    ctx = new Ctor({ latencyHint: 'interactive' })
    master = buildMaster(ctx)
    setAudioSessionType('playback')
  }
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

/**
 * Must be called from a user gesture. Safari will not start an AudioContext
 * any other way, and will silently suspend it again when the tab backgrounds.
 */
export async function ensureAudio(): Promise<AudioContext> {
  const context = getAudio()
  if (context.state === 'suspended') await context.resume()
  return context
}

export function getAnalyser(): AnalyserNode | null {
  return master?.analyser ?? null
}

/**
 * Hall Mode. A phone speaker in a church basement against forty people is a
 * losing fight, so this leans on everything that makes a small speaker read as
 * loud: lose the lows it can't produce, saturate for upper harmonics, push a
 * presence bump right where the ear is most sensitive, and compress hard.
 */
export function setHallMode(on: boolean) {
  if (!ctx || !master) return
  const t = ctx.currentTime
  const ramp = (p: AudioParam, v: number) => {
    p.cancelScheduledValues(t)
    p.setTargetAtTime(v, t, 0.05)
  }
  ramp(master.highpass.frequency, on ? 135 : 60)
  ramp(master.wet.gain, on ? 0.55 : 0)
  ramp(master.dry.gain, on ? 0.55 : 1)
  ramp(master.presence.gain, on ? 5.5 : 0)
  ramp(master.comp.threshold, on ? -24 : -12)
  ramp(master.comp.ratio, on ? 5 : 3)
  ramp(master.makeup.gain, on ? 1.5 : 1)
}

export function setMasterVolume(v: number) {
  if (!ctx || !master) return
  master.bus.gain.setTargetAtTime(v, ctx.currentTime, 0.03)
  master.clickBus.gain.setTargetAtTime(v, ctx.currentTime, 0.03)
}

// ---------------------------------------------------------------------------
// The reed
// ---------------------------------------------------------------------------

let reedWave: PeriodicWave | null = null
let noiseBuffer: AudioBuffer | null = null

/**
 * Free-reed harmonic profile: strong fundamental, a fat second and third, and
 * a slow rolloff with the odd harmonics sitting slightly proud of the evens.
 * That odd-harmonic lean is what gives a pitch pipe its reedy buzz.
 */
const REED_HARMONICS = [
  0, 1.0, 0.62, 0.5, 0.26, 0.24, 0.13, 0.12, 0.07, 0.065, 0.04, 0.037, 0.025,
  0.022, 0.015, 0.013, 0.01,
]

function getReedWave(context: AudioContext): PeriodicWave {
  if (!reedWave) {
    const real = new Float32Array(REED_HARMONICS.length)
    const imag = new Float32Array(REED_HARMONICS)
    reedWave = context.createPeriodicWave(real, imag, {
      disableNormalization: false,
    })
  }
  return reedWave
}

function getNoiseBuffer(context: AudioContext): AudioBuffer {
  if (!noiseBuffer) {
    const len = context.sampleRate * 2
    noiseBuffer = context.createBuffer(1, len, context.sampleRate)
    const data = noiseBuffer.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
  }
  return noiseBuffer
}

/**
 * Chords need headroom. Four reeds at full tilt into a limiter just sounds like
 * mush, so each voice backs off as the stack grows.
 */
function voiceGainFor(count: number): number {
  return 0.42 / Math.sqrt(Math.max(1, count))
}

export interface VoiceOptions {
  freq: number
  /** Peak level before the master bus. */
  level: number
  /** Seconds to wait before this voice speaks — used for the chord bloom. */
  delay?: number
  /**
   * Breath mode. The voice starts inert and every parameter is driven live by
   * setPressure() instead. Scheduling an attack envelope *and* streaming
   * setTargetAtTime into the same AudioParam interleaves automation events at
   * overlapping times, which is a reliable way to get glitches — so a driven
   * voice schedules nothing.
   */
  driven?: boolean
}

/**
 * One reed. Created per sounded note and thrown away on release; Web Audio
 * nodes are cheap and this keeps state impossible to leak between notes.
 */
export class ReedVoice {
  private ctx: AudioContext
  private osc1: OscillatorNode
  private osc2: OscillatorNode
  private body: BiquadFilterNode
  private noise: AudioBufferSourceNode
  private noiseBand: BiquadFilterNode
  private noiseGain: GainNode
  private amp: GainNode
  private level: number
  private stopped = false

  constructor(context: AudioContext, dest: AudioNode, opts: VoiceOptions) {
    this.ctx = context
    this.level = opts.level
    const driven = opts.driven ?? false
    const t0 = context.currentTime + (opts.delay ?? 0)
    const wave = getReedWave(context)

    this.amp = context.createGain()
    this.amp.gain.value = 0

    // Lowpass that opens with air pressure — a reed gets brighter the harder
    // you blow, and this is most of why the attack feels physical.
    this.body = context.createBiquadFilter()
    this.body.type = 'lowpass'
    this.body.Q.value = 0.8
    if (driven) {
      this.body.frequency.value = 700
    } else {
      this.body.frequency.setValueAtTime(650, t0)
      this.body.frequency.exponentialRampToValueAtTime(
        Math.min(9000, Math.max(2200, opts.freq * 14)),
        t0 + 0.09,
      )
    }

    this.osc1 = context.createOscillator()
    this.osc1.setPeriodicWave(wave)
    this.osc1.frequency.setValueAtTime(opts.freq, t0)

    // Second reed a few cents off. Real pipes beat slightly against
    // themselves; dead-centre unison sounds synthetic.
    this.osc2 = context.createOscillator()
    this.osc2.setPeriodicWave(wave)
    this.osc2.frequency.setValueAtTime(opts.freq, t0)

    if (driven) {
      this.osc1.detune.value = 0
      this.osc2.detune.value = 5.5
    } else {
      // Pressure bend: the reed starts flat and pulls up to pitch as the air
      // column establishes. ~70ms, and it is *very* noticeable when missing.
      for (const osc of [this.osc1, this.osc2]) {
        const base = osc === this.osc2 ? 5.5 : 0
        osc.detune.setValueAtTime(base - 22, t0)
        osc.detune.linearRampToValueAtTime(base, t0 + 0.07)
      }
    }

    const oscMix = context.createGain()
    oscMix.gain.value = 0.5
    this.osc1.connect(oscMix)
    this.osc2.connect(oscMix)
    oscMix.connect(this.body)

    // Air. A chiff burst on the attack, then a quiet bed underneath.
    this.noise = context.createBufferSource()
    this.noise.buffer = getNoiseBuffer(context)
    this.noise.loop = true
    this.noiseBand = context.createBiquadFilter()
    this.noiseBand.type = 'bandpass'
    this.noiseBand.frequency.value = Math.min(6000, opts.freq * 6)
    this.noiseBand.Q.value = 0.7
    this.noiseGain = context.createGain()
    if (driven) {
      this.noiseGain.gain.value = 0
    } else {
      this.noiseGain.gain.setValueAtTime(0, t0)
      this.noiseGain.gain.linearRampToValueAtTime(this.level * 0.5, t0 + 0.012)
      this.noiseGain.gain.exponentialRampToValueAtTime(
        Math.max(0.0001, this.level * 0.05),
        t0 + 0.11,
      )
    }
    this.noise.connect(this.noiseBand)
    this.noiseBand.connect(this.noiseGain)
    this.noiseGain.connect(this.body)

    this.body.connect(this.amp)
    this.amp.connect(dest)

    this.osc1.start(t0)
    this.osc2.start(t0)
    this.noise.start(t0)
  }

  /** Fixed-envelope attack, for press-and-hold. */
  attack(delay = 0) {
    const t0 = this.ctx.currentTime + delay
    this.amp.gain.cancelScheduledValues(t0)
    this.amp.gain.setValueAtTime(0.0001, t0)
    this.amp.gain.linearRampToValueAtTime(this.level * 1.12, t0 + 0.035)
    this.amp.gain.setTargetAtTime(this.level, t0 + 0.035, 0.09)
  }

  /**
   * Continuous drive, for breath mode. `pressure` is 0..1 and maps to loudness,
   * brightness and air noise all at once, the way it does on a real reed.
   */
  setPressure(pressure: number) {
    if (this.stopped) return
    const t = this.ctx.currentTime
    const p = Math.max(0, Math.min(1, pressure))
    // Perceptual curve — linear mic level feels unresponsive at the bottom.
    const shaped = p * p * (3 - 2 * p)
    this.amp.gain.setTargetAtTime(this.level * shaped, t, 0.028)
    this.body.frequency.setTargetAtTime(700 + shaped * 6000, t, 0.05)
    this.noiseGain.gain.setTargetAtTime(this.level * (0.03 + p * 0.09), t, 0.04)
    // Blow harder, go slightly sharp. Every wind player knows this feeling.
    const bend = shaped * 6 - 3
    this.osc1.detune.setTargetAtTime(bend, t, 0.06)
    this.osc2.detune.setTargetAtTime(5.5 + bend, t, 0.06)
  }

  release() {
    if (this.stopped) return
    this.stopped = true
    const t = this.ctx.currentTime
    const end = t + 0.22

    this.amp.gain.cancelScheduledValues(t)
    this.amp.gain.setValueAtTime(Math.max(0.0001, this.amp.gain.value), t)
    this.amp.gain.exponentialRampToValueAtTime(0.0001, end)

    // The reed sags flat as the air runs out. Small detail, big realism.
    this.osc1.detune.cancelScheduledValues(t)
    this.osc1.detune.setValueAtTime(this.osc1.detune.value, t)
    this.osc1.detune.linearRampToValueAtTime(-14, end)

    this.noiseGain.gain.cancelScheduledValues(t)
    this.noiseGain.gain.setValueAtTime(
      Math.max(0.0001, this.noiseGain.gain.value),
      t,
    )
    this.noiseGain.gain.exponentialRampToValueAtTime(0.0001, end)

    this.osc1.stop(end + 0.05)
    this.osc2.stop(end + 0.05)
    this.noise.stop(end + 0.05)

    for (const n of [this.osc1, this.osc2, this.noise]) {
      n.onended = () => {
        try {
          n.disconnect()
        } catch {
          /* already torn down */
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Playback handle
// ---------------------------------------------------------------------------

export interface SoundingChord {
  voices: ReedVoice[]
  setPressure(p: number): void
  release(): void
}

export interface PlayChordOptions {
  freqs: number[]
  /** Seconds between successive voices entering. 0 = all at once. */
  bloom?: number
  /** Breath mode voices start silent and follow the mic instead. */
  driven?: boolean
}

export function playChord(opts: PlayChordOptions): SoundingChord | null {
  if (!ctx || !master) return null
  const level = voiceGainFor(opts.freqs.length)
  const bloom = opts.bloom ?? 0

  const voices = opts.freqs.map((freq, i) => {
    const delay = bloom * i
    const voice = new ReedVoice(ctx!, master!.bus, {
      freq,
      level,
      delay,
      driven: opts.driven,
    })
    if (!opts.driven) voice.attack(delay)
    return voice
  })

  return {
    voices,
    setPressure(p: number) {
      for (const v of voices) v.setPressure(p)
    },
    release() {
      for (const v of voices) v.release()
    },
  }
}

// ---------------------------------------------------------------------------
// Mechanical detent click
// ---------------------------------------------------------------------------

/**
 * The click when the disc passes a note. Quiet, dry, and mostly high-frequency
 * — it reads as "mechanism" rather than "beep". Half the satisfaction of
 * spinning the thing lives in this eight-millisecond sound.
 */
export function playDetentClick(strength = 1) {
  if (!ctx || !master) return
  const t = ctx.currentTime
  const src = ctx.createBufferSource()
  src.buffer = getNoiseBuffer(ctx)
  src.loop = true

  const bp = ctx.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = 2600
  bp.Q.value = 1.6

  const hp = ctx.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = 900

  const g = ctx.createGain()
  const peak = 0.055 * Math.max(0.25, Math.min(1, strength))
  g.gain.setValueAtTime(0, t)
  g.gain.linearRampToValueAtTime(peak, t + 0.001)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.035)

  src.connect(bp)
  bp.connect(hp)
  hp.connect(g)
  g.connect(master.clickBus)

  src.start(t)
  src.stop(t + 0.05)
  src.onended = () => {
    try {
      src.disconnect()
    } catch {
      /* already torn down */
    }
  }
}
