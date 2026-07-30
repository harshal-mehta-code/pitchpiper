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

type SoundMode = 'hold' | 'breath'

/** Seconds between voices when a chord blooms open. */
const BLOOM_STEP = 0.075
/** Breath pressure below which we let the note die. */
const BREATH_FLOOR = 0.012

export default function App() {
  // --- persisted preferences ---------------------------------------------
  const [noteIndex, setNoteIndex] = usePersistentState('note', 7) // C
  const [chordId, setChordId] = usePersistentState('chord', 'unison')
  const [octaveShift, setOctaveShift] = usePersistentState('octave', 0)
  const [hallMode, setHallModeState] = usePersistentState('hall', false)
  const [useFlats, setUseFlats] = usePersistentState('flats', true)
  const [a4, setA4] = usePersistentState('a4', 440)
  const [volume, setVolume] = usePersistentState('volume', 0.85)
  const [sensitivity, setSensitivity] = usePersistentState('sensitivity', 0.5)
  const [keepAwake, setKeepAwake] = usePersistentState('awake', true)

  // --- session state -------------------------------------------------------
  const [breathMode, setBreathMode] = useState(false)
  const [breathStatus, setBreathStatus] = useState<BreathStatus>('idle')
  const [hubActive, setHubActive] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

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

  const onHubDown = useCallback(() => {
    setHubActive(true)
    void prepareAudio().then(() => startSound('hold'))
  }, [prepareAudio, startSound])

  const onHubUp = useCallback(() => {
    setHubActive(false)
    if (soundModeRef.current === 'hold') stopSound()
  }, [stopSound])

  // Re-voice a sounding note when the pitch under it changes, so spinning the
  // disc mid-note actually moves the pitch instead of being ignored.
  useEffect(() => {
    if (soundModeRef.current) startSound(soundModeRef.current)
  }, [noteIndex, chordId, octaveShift, a4, startSound])

  useEffect(() => setHallMode(hallMode), [hallMode])
  useEffect(() => setMasterVolume(volume), [volume])

  // --- breath --------------------------------------------------------------
  const detectorRef = useRef<BreathDetector | null>(null)

  const handleBreathFrame = useCallback(
    (f: BreathFrame) => {
      breathFrameRef.current = f
      // A held note wins. If a thumb is on the hub, the mic stays out of it.
      if (soundModeRef.current === 'hold') return

      if (f.pressure > BREATH_FLOOR) {
        if (soundModeRef.current !== 'breath') startSound('breath')
        soundRef.current?.setPressure(f.pressure)
      } else if (soundModeRef.current === 'breath') {
        stopSound()
      }
    },
    [startSound, stopSound],
  )

  const getDetector = useCallback(() => {
    if (!detectorRef.current) {
      detectorRef.current = new BreathDetector(handleBreathFrame, (s) =>
        setBreathStatus(s),
      )
    }
    detectorRef.current.sensitivity = sensitivity
    return detectorRef.current
  }, [handleBreathFrame, sensitivity])

  const handleBreathMode = useCallback(
    (on: boolean) => {
      setBreathMode(on)
      const det = getDetector()
      if (on) {
        // Started straight from the click so the browser still sees an active
        // user gesture — both getUserMedia and Safari's audio unlock need it.
        void prepareAudio().then((ctx) => det.start(ctx))
      } else {
        det.stop()
        if (soundModeRef.current === 'breath') stopSound()
      }
    },
    [getDetector, prepareAudio, stopSound],
  )

  useEffect(() => {
    if (detectorRef.current) detectorRef.current.sensitivity = sensitivity
  }, [sensitivity])

  useEffect(() => () => detectorRef.current?.stop(), [])

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

  const hint = breathMode
    ? 'Blow at your phone — or hold the middle'
    : 'Hold the middle. Spin the ring to change note.'

  return (
    <div className="app">
      <header className="topbar">
        <div className="wordmark">
          Pipe<span>Dream</span>
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
        <BreathMeter status={breathStatus} frameRef={breathFrameRef} />
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
      />
    </div>
  )
}
