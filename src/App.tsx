import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PitchDisc } from './ui/PitchDisc'
import { ControlTray } from './ui/ControlTray'
import { BreathMeter } from './ui/BreathMeter'
import { SettingsSheet } from './ui/SettingsSheet'
import { usePersistentState } from './hooks/usePersistentState'
import { useWakeLock } from './hooks/useWakeLock'
import {
  BreathDetector,
  type BreathFrame,
  type BreathStatus,
} from './audio/breath'
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
  chordById,
  midiToName,
  noteLabel,
  PIPE_NOTES,
} from './music/notes'

type SoundMode = 'hold' | 'breath' | 'puff'

/**
 * How breath drives the pipe.
 *
 * 'puff'  — a breath triggers the note, then the microphone is released and
 *           the chord rings out on its own. The default, because iOS forces
 *           the audio session into playAndRecord while any microphone track is
 *           live, which routes output away from the loudspeaker and drops the
 *           volume badly. Letting go of the microphone before making a sound
 *           costs nothing and gets the volume back.
 * 'live'  — the microphone stays open and drives loudness and timbre
 *           continuously, like a real reed. Lovely where the platform allows
 *           it; unusably quiet on an iPhone.
 */
export type BreathResponse = 'puff' | 'live'

/** Seconds between voices when a chord blooms open. */
const BLOOM_STEP = 0.075
/** Breath pressure below which we let the note die. */
const BREATH_FLOOR = 0.012
/** How long a puff-triggered note rings before it decays. */
const PUFF_SUSTAIN_MS = 2600
/** Breathing room after a note before we re-open the microphone. */
const REARM_DELAY_MS = 220

export default function App() {
  // --- persisted preferences ---------------------------------------------
  const [noteIndex, setNoteIndex] = usePersistentState('note', 7) // C
  const [chordId, setChordId] = usePersistentState('chord', 'unison')
  const [octaveShift, setOctaveShift] = usePersistentState('octave', 0)
  const [hallMode, setHallModeState] = usePersistentState('hall', false)
  const [useFlats, setUseFlats] = usePersistentState('flats', true)
  const [a4, setA4] = usePersistentState('a4', 440)
  const [volume, setVolume] = usePersistentState('volume', 0.85)
  const [sensitivity, setSensitivity] = usePersistentState('sensitivity', 0.65)
  const [keepAwake, setKeepAwake] = usePersistentState('awake', true)
  const [breathResponse, setBreathResponse] = usePersistentState<BreathResponse>(
    'breathResponse',
    'puff',
  )
  const [micDeviceId, setMicDeviceId] = usePersistentState<string | null>(
    'micDevice',
    null,
  )

  // --- session state -------------------------------------------------------
  const [breathMode, setBreathMode] = useState(false)
  const [breathStatus, setBreathStatus] = useState<BreathStatus>('idle')
  const [breathDetail, setBreathDetail] = useState<string | undefined>()
  const [hubActive, setHubActive] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
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

  const paramsRef = useRef({ noteIndex, chordId, octaveShift, a4 })
  paramsRef.current = { noteIndex, chordId, octaveShift, a4 }
  const settingsRef = useRef({ hallMode, volume })
  settingsRef.current = { hallMode, volume }

  const detectorRef = useRef<BreathDetector | null>(null)
  const breathOnRef = useRef(breathMode)
  breathOnRef.current = breathMode
  const responseRef = useRef(breathResponse)
  responseRef.current = breathResponse
  const puffTimersRef = useRef<{ end?: number; rearm?: number }>({})

  // --- sounding ------------------------------------------------------------
  const startSound = useCallback((mode: SoundMode) => {
    const { noteIndex: n, chordId: c, octaveShift: o, a4: tuning } =
      paramsRef.current
    const chord = chordById(c)
    const tones = buildChord(PIPE_NOTES[n], chord, o, tuning)

    soundRef.current?.release()
    soundRef.current = playChord({
      freqs: tones.map((t) => t.freq),
      // Breath-driven voices all speak together — a staggered entry fights the
      // pressure curve your lungs are already providing.
      bloom: mode === 'breath' || tones.length === 1 ? 0 : BLOOM_STEP,
      driven: mode === 'breath',
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

  /** Re-open the microphone if breath mode is still on. Safe to call twice. */
  const rearmBreath = useCallback(() => {
    if (!breathOnRef.current) return
    void detectorRef.current?.start(getAudio())
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
    if (soundModeRef.current === 'hold') stopSound()
    rearmBreath()
  }, [rearmBreath, stopSound])

  // Re-voice a sounding note when the pitch under it changes, so spinning the
  // disc mid-note actually moves the pitch instead of being ignored.
  useEffect(() => {
    if (soundModeRef.current) startSound(soundModeRef.current)
  }, [noteIndex, chordId, octaveShift, a4, startSound])

  useEffect(() => setHallMode(hallMode), [hallMode])
  useEffect(() => setMasterVolume(volume), [volume])

  // --- breath --------------------------------------------------------------

  /**
   * A breath fires the note, and the microphone is dropped before a sound is
   * made. On iOS a live capture track pins the audio session to playAndRecord,
   * which routes output off the loudspeaker and makes the pipe quieter than
   * the breath that triggered it — so the order here is the entire point.
   */
  const triggerPuff = useCallback(() => {
    clearPuffTimers()
    detectorRef.current?.stop()
    setPuffSounding(true)
    startSound('puff')

    puffTimersRef.current.end = window.setTimeout(() => {
      if (soundModeRef.current === 'puff') stopSound()
      setPuffSounding(false)
      puffTimersRef.current.rearm = window.setTimeout(
        rearmBreath,
        REARM_DELAY_MS,
      )
    }, PUFF_SUSTAIN_MS)
  }, [clearPuffTimers, rearmBreath, startSound, stopSound])

  const handleBreathFrame = useCallback(
    (f: BreathFrame) => {
      breathFrameRef.current = f
      // A held note wins. If a thumb is on the hub, the mic stays out of it.
      if (soundModeRef.current === 'hold') return

      if (responseRef.current === 'puff') {
        // One note per breath. The microphone is released the instant this
        // fires, so it cannot retrigger until it has been armed again.
        if (f.blowing && soundModeRef.current !== 'puff') triggerPuff()
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
    detectorRef.current.deviceId = micDeviceId
    return detectorRef.current
  }, [micDeviceId, sensitivity])

  const handleBreathMode = useCallback(
    (on: boolean) => {
      setBreathMode(on)
      const det = getDetector()
      if (on) {
        // Deliberately synchronous up to the getUserMedia call. Safari only
        // allows the microphone prompt while a user gesture is still live, and
        // awaiting the audio context first can spend that window.
        const ctx = getAudio()
        setHallMode(settingsRef.current.hallMode)
        setMasterVolume(settingsRef.current.volume)
        void det.start(ctx).then((ok) => {
          // Device labels are blank until permission has been granted, so the
          // list is only worth fetching once the microphone is actually open.
          if (ok) void BreathDetector.listInputs().then(setMicInputs)
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
  }, [onHubDown, onHubUp, setNoteIndex, settingsOpen])

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
  const note = PIPE_NOTES[noteIndex]
  const centerLabel = noteLabel(note, useFlats)
  const tones = buildChord(note, chord, octaveShift, a4)
  const centerSub =
    chord.id === 'unison'
      ? `${Math.round(tones[0].freq * 10) / 10} Hz`
      : chord.label

  const handleNoteIndexChange = useCallback(
    (i: number) => setNoteIndex(i),
    [setNoteIndex],
  )

  const hint = !breathMode
    ? 'Hold the middle. Spin the ring to change note.'
    : breathResponse === 'puff'
      ? 'One puff at the bottom of your phone — or hold the middle'
      : 'Blow at your phone — or hold the middle'

  return (
    <div className="app">
      <header className="topbar">
        <div className="wordmark">
          Pitch<span>Piper</span>
        </div>
        <div className="tuning-badge">A={a4}</div>
      </header>

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
        />
        {/* Each part's actual note, so a director can just read them out
            instead of working the chord out in their head. */}
        {tones.length > 1 && (
          <div className="parts">
            {tones.map((t) => (
              <div className="part" key={t.part}>
                <span className="part-name">{t.part}</span>
                <span className="part-note">
                  {midiToName(t.midi, useFlats)}
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="hint-line">{hint}</p>
      </main>

      {breathMode && (
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
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <SettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        a4={a4}
        onA4={setA4}
        useFlats={useFlats}
        onUseFlats={setUseFlats}
        keepAwake={keepAwake}
        onKeepAwake={setKeepAwake}
        sensitivity={sensitivity}
        onSensitivity={setSensitivity}
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
