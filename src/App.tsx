import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { PitchDisc } from './ui/PitchDisc'
import { ControlTray } from './ui/ControlTray'
import { BreathMeter } from './ui/BreathMeter'
import { SettingsSheet } from './ui/SettingsSheet'
import { TuneView, type TuneMode } from './ui/TuneView'
import { SetlistSheet } from './ui/SetlistSheet'
import { setlistFromLocation, type SetlistEntry } from './music/setlist'
import { usePersistentState } from './hooks/usePersistentState'
import { useWakeLock } from './hooks/useWakeLock'
import {
  BreathDetector,
  prefersPuffMode,
  type BreathFrame,
  type BreathStatus,
} from './audio/breath'
import { listAudioInputs } from './audio/mic'
import { nearestRatio, type RingTarget } from './audio/ring'
import {
  ensureAudio,
  getAnalyser,
  getAudio,
  playChord,
  setHallMode,
  setMasterVolume,
  type SoundingChord,
} from './audio/engine'
import {
  buildChord,
  buildStack,
  chordById,
  midiToName,
  noteLabel,
  PIPE_NOTES,
  STACK_ID,
  VOICE_PARTS,
  type ChordTone,
} from './music/notes'

type SoundMode = 'hold' | 'breath' | 'puff' | 'drone'

/** Which screen is up. The pipe is always where you land. */
type View = 'pipe' | 'tune'

/**
 * How breath drives the pipe.
 *
 * 'live'  — the microphone stays open and drives loudness and timbre
 *           continuously, the way a real reed behaves. This is the better
 *           instrument and the default everywhere it works.
 * 'puff'  — a breath triggers the note, the microphone is released, and the
 *           chord rings out on its own. The default on Apple's mobile
 *           platforms only, where a live capture track pins the audio session
 *           to playAndRecord, routes output off the loudspeaker, and leaves the
 *           pipe quieter than the breath that triggered it. Nothing in the web
 *           platform can override the output port, so the only lever is how
 *           long the microphone is held.
 *
 * Both are always offered; only which one starts selected varies.
 */
export type BreathResponse = 'puff' | 'live'

/** Seconds between voices when a chord blooms open. */
const BLOOM_STEP = 0.075
/** Breath pressure below which we let the note die. */
const BREATH_FLOOR = 0.012
/**
 * How long a puff-triggered note rings, from a gentle breath to a hard one.
 * The microphone is deaf while the note sounds, so the breath that started it
 * is the only expression available — it had better count for something.
 */
const PUFF_SUSTAIN_MIN_MS = 1600
const PUFF_SUSTAIN_MAX_MS = 3100
/** Breathing room after a note before we re-open the microphone. */
const REARM_DELAY_MS = 220

interface SoundParams {
  noteIndex: number
  chordId: string
  octaveShift: number
  a4: number
  stack: number[]
  useFlats: boolean
  justTuning: boolean
}

/**
 * What the pipe would sound right now.
 *
 * One function rather than two branches everywhere, because the notes on screen
 * and the notes coming out of the speaker drifting apart is the one bug in this
 * app nobody would ever report — they'd just quietly stop trusting it.
 */
function tonesFor(p: SoundParams): ChordTone[] {
  if (p.chordId === STACK_ID) {
    // An empty stack still sounds the selected note, so the hub is never dead.
    const offsets = p.stack.length ? p.stack : [PIPE_NOTES[p.noteIndex].index]
    // A stack has no root and no chord identity, so there is nothing to tune
    // justly *to*. Equal temperament is the honest answer there.
    return buildStack(offsets, p.octaveShift, p.a4, p.useFlats)
  }
  return buildChord(
    PIPE_NOTES[p.noteIndex],
    chordById(p.chordId),
    p.octaveShift,
    p.a4,
    p.justTuning,
  )
}

export default function App() {
  // --- persisted preferences ---------------------------------------------
  const [noteIndex, setNoteIndex] = usePersistentState('note', 7) // C
  const [chordId, setChordId] = usePersistentState('chord', 'unison')
  const [stack, setStack] = usePersistentState<number[]>('stack', [])
  const [octaveShift, setOctaveShift] = usePersistentState('octave', 0)
  const [hallMode, setHallModeState] = usePersistentState('hall', false)
  const [useFlats, setUseFlats] = usePersistentState('flats', true)
  const [a4, setA4] = usePersistentState('a4', 440)
  const [volume, setVolume] = usePersistentState('volume', 0.85)
  const [sensitivity, setSensitivity] = usePersistentState('sensitivity', 0.65)
  const [smoothing, setSmoothing] = usePersistentState('breathSmoothing', 0.45)
  const [keepAwake, setKeepAwake] = usePersistentState('awake', true)
  const [tuneMode, setTuneMode] = usePersistentState<TuneMode>('tuneMode', 'voice')
  const [setlist, setSetlist] = usePersistentState<SetlistEntry[]>('setlist', [])
  // Just by default. This is a barbershop instrument, and an equal-tempered
  // chord is not the sound anyone here is trying to make.
  const [justTuning, setJustTuning] = usePersistentState('just', true)
  const [breathResponse, setBreathResponse] = usePersistentState<BreathResponse>(
    'breathResponse',
    prefersPuffMode() ? 'puff' : 'live',
  )
  const [micDeviceId, setMicDeviceId] = usePersistentState<string | null>(
    'micDevice',
    null,
  )

  // --- session state -------------------------------------------------------
  const [view, setView] = useState<View>('pipe')
  const [breathMode, setBreathMode] = useState(false)
  const [breathStatus, setBreathStatus] = useState<BreathStatus>('idle')
  const [breathDetail, setBreathDetail] = useState<string | undefined>()
  const [hubActive, setHubActive] = useState(false)
  /** Latched: the chord keeps sounding with nothing held down. */
  const [drone, setDrone] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [setlistOpen, setSetlistOpen] = useState(false)
  /** A setlist that came in on the URL and hasn't been accepted yet. */
  const [incoming, setIncoming] = useState<SetlistEntry[] | null>(null)
  /** True while a puff-triggered note is ringing with the microphone released. */
  const [puffSounding, setPuffSounding] = useState(false)
  const [micInputs, setMicInputs] = useState<MediaDeviceInfo[]>([])

  useWakeLock(keepAwake)

  // --- live refs -----------------------------------------------------------
  // The audio and animation paths read these instead of props, so a 60fps
  // breath signal never triggers a React render.
  const glowRef = useRef(0)
  const soundRef = useRef<SoundingChord | null>(null)
  const soundModeRef = useRef<SoundMode | null>(null)
  const breathFrameRef = useRef<BreathFrame | null>(null)

  const paramsRef = useRef<SoundParams>({
    noteIndex,
    chordId,
    octaveShift,
    a4,
    stack,
    useFlats,
    justTuning,
  })
  paramsRef.current = {
    noteIndex,
    chordId,
    octaveShift,
    a4,
    stack,
    useFlats,
    justTuning,
  }
  const settingsRef = useRef({ hallMode, volume })
  settingsRef.current = { hallMode, volume }

  const detectorRef = useRef<BreathDetector | null>(null)
  const breathOnRef = useRef(breathMode)
  breathOnRef.current = breathMode
  const responseRef = useRef(breathResponse)
  responseRef.current = breathResponse
  const droneRef = useRef(drone)
  droneRef.current = drone
  /** Breath mode is toggled from further down the file than its callers. */
  const handleBreathModeRef = useRef<(on: boolean) => void>(() => {})
  const puffTimersRef = useRef<{ end?: number; rearm?: number }>({})
  /** Whether breath mode was on when the tuner took the microphone away. */
  const breathWasOnRef = useRef(false)

  // --- sounding ------------------------------------------------------------
  const startSound = useCallback((mode: SoundMode, strength = 1) => {
    const tones = tonesFor(paramsRef.current)

    soundRef.current?.release()
    soundRef.current = playChord({
      freqs: tones.map((t) => t.freq),
      // Breath-driven voices all speak together — a staggered entry fights the
      // pressure curve your lungs are already providing.
      bloom: mode === 'breath' || tones.length === 1 ? 0 : BLOOM_STEP,
      driven: mode === 'breath',
      levelScale: mode === 'puff' ? 0.72 + 0.28 * strength : 1,
    })
    soundModeRef.current = soundRef.current ? mode : null
  }, [])

  const stopSound = useCallback(() => {
    soundRef.current?.release()
    soundRef.current = null
    soundModeRef.current = null
  }, [])

  const prepareAudio = useCallback(async () => {
    const ctx = await ensureAudio()
    // These are no-ops before the context exists, so re-apply on first unlock.
    setHallMode(settingsRef.current.hallMode)
    setMasterVolume(settingsRef.current.volume)
    return ctx
  }, [])

  const clearPuffTimers = useCallback(() => {
    const t = puffTimersRef.current
    if (t.end) window.clearTimeout(t.end)
    if (t.rearm) window.clearTimeout(t.rearm)
    puffTimersRef.current = {}
  }, [])

  /** Listen again if breath mode is still on. Safe to call twice. */
  const rearmBreath = useCallback(() => {
    if (!breathOnRef.current) return
    detectorRef.current?.resume(getAudio())
  }, [])

  const onHubDown = useCallback(() => {
    setHubActive(true)
    // A thumb on the hub takes over from a ringing puff.
    clearPuffTimers()
    setPuffSounding(false)
    void prepareAudio().then(() => startSound('hold'))
  }, [clearPuffTimers, prepareAudio, startSound])

  const onHubUp = useCallback(() => {
    setHubActive(false)
    // Letting go re-articulates the drone rather than killing it: while it is
    // latched, the only thing that stops the sound is the latch.
    if (soundModeRef.current !== 'hold') return
    if (droneRef.current) {
      startSound('drone')
      return
    }
    stopSound()
    rearmBreath()
  }, [rearmBreath, startSound, stopSound])

  /**
   * Latch the pitch on.
   *
   * Sustained tuning work — matching a vowel, finding a chord by ear, holding a
   * reference while a section works something out — wants a drone, and a thumb
   * held on the hub for two minutes is not that. Mutually exclusive with breath
   * input, which would otherwise be listening to the drone.
   */
  const toggleDrone = useCallback(
    (on: boolean) => {
      setDrone(on)
      if (on) {
        if (breathOnRef.current) handleBreathModeRef.current(false)
        void prepareAudio().then(() => {
          if (droneRef.current) startSound('drone')
        })
      } else if (soundModeRef.current === 'drone') {
        stopSound()
      }
    },
    [prepareAudio, startSound, stopSound],
  )

  // Re-voice a sounding note when the pitch under it changes, so spinning the
  // disc — or adding a note to the stack — moves the sound instead of being
  // ignored until the next press.
  useEffect(() => {
    if (soundModeRef.current) startSound(soundModeRef.current)
  }, [noteIndex, chordId, octaveShift, a4, stack, justTuning, startSound])

  useEffect(() => setHallMode(hallMode), [hallMode])
  useEffect(() => setMasterVolume(volume), [volume])

  // --- the stack -----------------------------------------------------------

  /**
   * A hole cycles off → in → an octave up → off.
   *
   * Three states on one tap keeps voicing control on the instrument itself. The
   * alternative — a separate list of notes with octave steppers beside each —
   * is how every other app does it, and it is a worse thing to use in a hurry.
   */
  const toggleStack = useCallback(
    (index: number) => {
      setStack((prev) => {
        const hasBase = prev.includes(index)
        const hasUp = prev.includes(index + 12)
        if (hasBase) return [...prev.filter((v) => v !== index), index + 12].sort(byValue)
        if (hasUp) return prev.filter((v) => v !== index + 12)
        return [...prev, index].sort(byValue)
      })
    },
    [setStack],
  )

  // --- the setlist ---------------------------------------------------------

  /**
   * A shared list opens the sheet rather than being applied.
   *
   * A link from a director shouldn't be able to quietly overwrite the book
   * somebody else has built, so what arrives is shown and offered — never
   * merged on their behalf. The hash is cleared either way, so a reload doesn't
   * ask a second time.
   */
  useEffect(() => {
    const arrived = setlistFromLocation()
    if (!arrived) return
    setIncoming(arrived)
    setSetlistOpen(true)
    history.replaceState(null, '', location.pathname + location.search)
  }, [])

  const acceptIncoming = useCallback(
    (mode: 'add' | 'replace') => {
      if (!incoming) return
      setSetlist((prev) => (mode === 'replace' ? incoming : [...prev, ...incoming]))
      setIncoming(null)
    },
    [incoming, setSetlist],
  )

  const loadEntry = useCallback(
    (e: SetlistEntry) => {
      setNoteIndex(e.noteIndex)
      setChordId(e.chordId)
      setOctaveShift(e.octaveShift)
      if (e.chordId === STACK_ID) setStack(e.stack)
    },
    [setChordId, setNoteIndex, setOctaveShift, setStack],
  )

  // --- breath --------------------------------------------------------------

  /**
   * A breath fires the note, and the microphone is dropped before a sound is
   * made. On iOS a live capture track pins the audio session to playAndRecord,
   * which routes output off the loudspeaker and makes the pipe quieter than
   * the breath that triggered it — so the order here is the entire point.
   */
  const triggerPuff = useCallback((strength: number) => {
    clearPuffTimers()
    // How this pauses is the detector's business: a full release where an open
    // microphone would keep playback quiet, a mute everywhere else.
    detectorRef.current?.pause()
    setPuffSounding(true)
    startSound('puff', strength)

    const sustain =
      PUFF_SUSTAIN_MIN_MS + (PUFF_SUSTAIN_MAX_MS - PUFF_SUSTAIN_MIN_MS) * strength
    puffTimersRef.current.end = window.setTimeout(() => {
      if (soundModeRef.current === 'puff') stopSound()
      setPuffSounding(false)
      puffTimersRef.current.rearm = window.setTimeout(
        rearmBreath,
        REARM_DELAY_MS,
      )
    }, sustain)
  }, [clearPuffTimers, rearmBreath, startSound, stopSound])

  const handleBreathFrame = useCallback(
    (f: BreathFrame) => {
      breathFrameRef.current = f
      // A held note wins. If a thumb is on the hub, the mic stays out of it.
      if (soundModeRef.current === 'hold') return

      if (responseRef.current === 'puff') {
        // One note per breath. The microphone is released the instant this
        // fires, so it cannot retrigger until it has been armed again.
        if (f.blowing && soundModeRef.current !== 'puff') {
          // How far past the trigger the breath landed, as a rough measure of
          // how hard it was blown. Taken on the opening frame because the
          // microphone is about to be let go of.
          const over = f.threshold > 0 ? f.energy / f.threshold : 1
          triggerPuff(Math.min(1, Math.max(0, (over - 1) / 5)))
        }
        return
      }

      if (f.pressure > BREATH_FLOOR) {
        if (soundModeRef.current !== 'breath') startSound('breath')
        soundRef.current?.setPressure(f.pressure)
      } else if (soundModeRef.current === 'breath') {
        stopSound()
      }
    },
    [startSound, stopSound, triggerPuff],
  )

  // The detector is built once but this callback is not stable, so it is
  // reached through a ref. Capturing the first version would leave the puff
  // path wired to a stale closure.
  const frameHandlerRef = useRef(handleBreathFrame)
  frameHandlerRef.current = handleBreathFrame

  const getDetector = useCallback(() => {
    if (!detectorRef.current) {
      detectorRef.current = new BreathDetector(
        (f) => frameHandlerRef.current(f),
        (s, d) => {
          setBreathStatus(s)
          setBreathDetail(d)
        },
      )
    }
    detectorRef.current.sensitivity = sensitivity
    detectorRef.current.smoothing = smoothing
    detectorRef.current.deviceId = micDeviceId
    return detectorRef.current
  }, [micDeviceId, sensitivity, smoothing])

  const handleBreathMode = useCallback(
    (on: boolean) => {
      setBreathMode(on)
      const det = getDetector()
      if (on) {
        // A drone into an open microphone is the detector listening to us.
        if (droneRef.current) {
          setDrone(false)
          if (soundModeRef.current === 'drone') stopSound()
        }
        // Deliberately synchronous up to the getUserMedia call. Safari only
        // allows the microphone prompt while a user gesture is still live, and
        // awaiting the audio context first can spend that window.
        const ctx = getAudio()
        setHallMode(settingsRef.current.hallMode)
        setMasterVolume(settingsRef.current.volume)
        void det.start(ctx).then((ok) => {
          // Device labels are blank until permission has been granted, so the
          // list is only worth fetching once the microphone is actually open.
          if (ok) void listAudioInputs().then(setMicInputs)
        })
      } else {
        clearPuffTimers()
        setPuffSounding(false)
        det.stop()
        if (soundModeRef.current === 'breath' || soundModeRef.current === 'puff') {
          stopSound()
        }
      }
    },
    [clearPuffTimers, getDetector, stopSound],
  )
  handleBreathModeRef.current = handleBreathMode

  /** Switching input device means tearing the stream down and asking again. */
  const handleMicDevice = useCallback(
    (id: string | null) => {
      setMicDeviceId(id)
      const det = detectorRef.current
      if (!det || !breathOnRef.current) return
      det.deviceId = id
      det.stop()
      det.recalibrate()
      void det.start(getAudio())
    },
    [setMicDeviceId],
  )

  useEffect(() => {
    if (detectorRef.current) detectorRef.current.sensitivity = sensitivity
  }, [sensitivity])

  useEffect(() => {
    if (detectorRef.current) detectorRef.current.smoothing = smoothing
  }, [smoothing])

  // Switching response mode mid-note would leave a voice stranded.
  useEffect(() => {
    clearPuffTimers()
    setPuffSounding(false)
    if (soundModeRef.current === 'breath' || soundModeRef.current === 'puff') {
      stopSound()
    }
    rearmBreath()
  }, [breathResponse, clearPuffTimers, rearmBreath, stopSound])

  useEffect(
    () => () => {
      clearPuffTimers()
      detectorRef.current?.stop()
    },
    [clearPuffTimers],
  )

  // --- views ---------------------------------------------------------------

  /**
   * Only one feature may hold the microphone at a time, and the tuner needs it
   * for as long as it is on screen. Breath mode stands down on the way in and
   * is put back on the way out.
   */
  const toggleTuner = useCallback(() => {
    if (view === 'tune') {
      setView('pipe')
      return
    }
    // Unlock the audio context inside the tap: the tuner asks for the
    // microphone from a layout effect, and Safari counts that as still being
    // in the gesture only if nothing has awaited in between.
    getAudio()
    breathWasOnRef.current = breathMode
    if (breathMode) handleBreathMode(false)
    // The tuner has its own latch, so the pipe's drone stands down rather than
    // leaving two things that both claim to be sounding the reference.
    setDrone(false)
    stopSound()
    setView('tune')
  }, [breathMode, handleBreathMode, stopSound, view])

  // A layout effect, so the tuner's stream is already released when breath mode
  // re-acquires — and so the re-acquire still happens inside the tap that
  // closed the tuner, which is what Safari requires.
  useLayoutEffect(() => {
    if (view !== 'pipe' || !breathWasOnRef.current) return
    breathWasOnRef.current = false
    handleBreathMode(true)
  }, [view, handleBreathMode])

  // --- glow ----------------------------------------------------------------
  // Driven from the output signal itself rather than from an envelope we track
  // separately, so the light is always telling the truth about the sound.
  useEffect(() => {
    let raf = 0
    let buf = new Float32Array(1024)
    const frame = () => {
      raf = requestAnimationFrame(frame)
      const analyser = getAnalyser()
      if (!analyser) {
        glowRef.current *= 0.9
        return
      }
      if (buf.length !== analyser.fftSize) buf = new Float32Array(analyser.fftSize)
      analyser.getFloatTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
      const rms = Math.sqrt(sum / buf.length)
      const target = Math.min(1, rms * 5.5)
      glowRef.current +=
        (target - glowRef.current) * (target > glowRef.current ? 0.4 : 0.12)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  // --- keyboard ------------------------------------------------------------
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.repeat || settingsOpen) return
      const target = e.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return

      if (e.code === 'Space') {
        e.preventDefault()
        onHubDown()
      } else if (view !== 'pipe') {
        return
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
        e.preventDefault()
        setNoteIndex((i) => Math.min(PIPE_NOTES.length - 1, i + 1))
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
        e.preventDefault()
        setNoteIndex((i) => Math.max(0, i - 1))
      }
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') onHubUp()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [onHubDown, onHubUp, setNoteIndex, settingsOpen, view])

  // A drag on the disc makes detent clicks before anything has ever been
  // sounded, so unlock audio on the very first touch anywhere.
  useEffect(() => {
    const unlock = () => void prepareAudio()
    window.addEventListener('pointerdown', unlock, { once: true })
    return () => window.removeEventListener('pointerdown', unlock)
  }, [prepareAudio])

  // --- derived -------------------------------------------------------------
  const labels = useMemo(
    () => PIPE_NOTES.map((n) => noteLabel(n, useFlats)),
    [useFlats],
  )
  const chord = chordById(chordId)
  const isStack = chordId === STACK_ID
  const note = PIPE_NOTES[noteIndex]
  const centerLabel = noteLabel(note, useFlats)
  // Memoised because the tuner treats a change of targets as a reason to throw
  // its readings away — a fresh array every render would reset it forever.
  const tones = useMemo(
    () => tonesFor({ noteIndex, chordId, octaveShift, a4, stack, useFlats, justTuning }),
    [noteIndex, chordId, octaveShift, a4, stack, useFlats, justTuning],
  )
  /**
   * What the ring test listens for: the chord's *ideal* ratios, always the just
   * ones even when the pipe is sounding equal temperament. Only a just chord
   * can ring, so those ratios are the yardstick either way — measuring an
   * equal-tempered take against them is how the 31 cents shows up.
   *
   * A stack has no chord to look up, so each note is matched to the simplest
   * fraction near its actual ratio against the lowest note. Two notes still
   * share partials whenever their ratio is near a simple one; that is all a
   * chord ever was.
   */
  const ringTargets = useMemo<RingTarget[]>(() => {
    if (isStack) {
      if (tones.length < 2) return []
      const root = tones[0].freq
      return tones.map((t) => {
        const [num, den] = nearestRatio(t.freq / root)
        return { part: t.part, num, den }
      })
    }
    if (chord.id === 'unison') return []
    return VOICE_PARTS.map((p) => ({
      part: p,
      num: chord.just[p][0],
      den: chord.just[p][1],
    }))
  }, [chord, isStack, tones])

  const centerSub = isStack
    ? stack.length
      ? `Stack · ${stack.length}`
      : 'Tap the holes'
    : chord.id === 'unison'
      ? `${Math.round(tones[0].freq * 10) / 10} Hz`
      : chord.label
  const chordLabel = isStack
    ? stack.length
      ? `Custom stack · ${stack.length} notes`
      : 'Custom stack — tap holes on the pipe'
    : chord.id === 'unison'
      ? `${centerLabel} alone`
      : `${centerLabel} ${chord.label}`

  const handleNoteIndexChange = useCallback(
    (i: number) => setNoteIndex(i),
    [setNoteIndex],
  )

  const hint = drone
    ? 'Droning. Tap Drone again to stop; spin the ring to move it.'
    : isStack
    ? 'Tap holes to stack them. Tap again for an octave up.'
    : !breathMode
      ? 'Hold the middle. Spin the ring to change note.'
      : breathResponse === 'puff'
        ? 'One puff at the bottom of your phone — or hold the middle'
        : 'Blow at your phone — or hold the middle'

  const tuning = view === 'tune'

  return (
    <div className="app">
      <header className="topbar">
        <div className="wordmark">
          Pitch<span>Piper</span>
        </div>
        <div className="topbar-right">
          <div className="tuning-badge">A={a4}</div>
          <button
            className={`icon-btn${setlistOpen ? ' is-on' : ''}`}
            onClick={() => setSetlistOpen(true)}
            aria-label="Setlist"
            title="Setlist — your songs and their starting pitches"
          >
            <ListIcon />
          </button>
          <button
            className={`icon-btn${tuning ? ' is-on' : ''}`}
            onClick={toggleTuner}
            aria-pressed={tuning}
            aria-label={tuning ? 'Back to the pipe' : 'Tuner'}
            title={tuning ? 'Back to the pipe' : 'Tuner — hear how you’re doing'}
          >
            {tuning ? <BackIcon /> : <ForkIcon />}
          </button>
        </div>
      </header>

      {tuning ? (
        <main className="stage stage-tune">
          <TuneView
            tones={tones}
            chordLabel={chordLabel}
            a4={a4}
            useFlats={useFlats}
            micDeviceId={micDeviceId}
            ringTargets={ringTargets}
            mode={tuneMode}
            onMode={setTuneMode}
            onReferenceDown={onHubDown}
            onReferenceUp={onHubUp}
          />
        </main>
      ) : (
        <main className="stage">
          <PitchDisc
            noteIndex={noteIndex}
            onNoteIndexChange={handleNoteIndexChange}
            labels={labels}
            centerLabel={centerLabel}
            centerSub={centerSub}
            glowRef={glowRef}
            hubActive={hubActive}
            onHubDown={onHubDown}
            onHubUp={onHubUp}
            stack={isStack ? stack : undefined}
            stackMode={isStack}
            onToggleStack={toggleStack}
          />
          {/* Each part's actual note, so a director can just read them out
              instead of working the chord out in their head. */}
          {tones.length > 1 && (
            <div className={`parts${isStack ? ' is-stack' : ''}`}>
              {tones.map((t) => (
                <div className="part" key={`${t.part}-${t.midi}`}>
                  {!isStack && <span className="part-name">{t.part}</span>}
                  <span className="part-note">
                    {isStack ? t.part : midiToName(t.midi, useFlats)}
                  </span>
                </div>
              ))}
            </div>
          )}
          <p className="hint-line">{hint}</p>
        </main>
      )}

      {breathMode && !tuning && (
        <BreathMeter
          status={breathStatus}
          detail={breathDetail}
          sounding={puffSounding}
          frameRef={breathFrameRef}
        />
      )}

      <ControlTray
        chordId={chordId}
        onChordId={setChordId}
        octaveShift={octaveShift}
        onOctaveShift={setOctaveShift}
        hallMode={hallMode}
        onHallMode={setHallModeState}
        breathMode={breathMode}
        onBreathMode={handleBreathMode}
        drone={drone}
        onDrone={toggleDrone}
        onOpenSettings={() => setSettingsOpen(true)}
        compact={tuning}
        // In the tuner the same picker chooses what is listened for and what
        // the reference button gives you — which of those it is depends on
        // which half of the tuner is up.
        label={tuning ? (tuneMode === 'voice' ? 'Reference' : 'Listening for') : 'Chord'}
      />

      <SetlistSheet
        open={setlistOpen}
        onClose={() => setSetlistOpen(false)}
        list={setlist}
        onList={setSetlist}
        useFlats={useFlats}
        current={{ noteIndex, chordId, octaveShift, stack }}
        onLoad={loadEntry}
        incoming={incoming}
        onAcceptIncoming={acceptIncoming}
        onDismissIncoming={() => setIncoming(null)}
      />

      <SettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        a4={a4}
        onA4={setA4}
        useFlats={useFlats}
        onUseFlats={setUseFlats}
        justTuning={justTuning}
        onJustTuning={setJustTuning}
        keepAwake={keepAwake}
        onKeepAwake={setKeepAwake}
        sensitivity={sensitivity}
        onSensitivity={setSensitivity}
        smoothing={smoothing}
        onSmoothing={setSmoothing}
        breathMode={breathMode}
        onRecalibrate={() => detectorRef.current?.recalibrate()}
        volume={volume}
        onVolume={setVolume}
        breathFrameRef={breathFrameRef}
        breathResponse={breathResponse}
        onBreathResponse={setBreathResponse}
        micInputs={micInputs}
        micDeviceId={micDeviceId}
        onMicDevice={handleMicDevice}
      />
    </div>
  )
}

function byValue(a: number, b: number): number {
  return a - b
}

function ForkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8.5 3v7.5a3.5 3.5 0 0 0 7 0V3" />
      <path d="M12 14v7" />
    </svg>
  )
}

function ListIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 6.5h11M9 12h11M9 17.5h11" />
      <path d="M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" />
    </svg>
  )
}

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14.5 5.5 8 12l6.5 6.5" />
    </svg>
  )
}
