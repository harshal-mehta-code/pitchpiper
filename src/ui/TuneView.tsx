import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  IN_TUNE_CENTS,
  PitchAnalyzer,
  type AnalyzerStatus,
  type ChordReading,
  type VoiceReading,
} from '../audio/analyzer'
import { getAudio } from '../audio/engine'
import { RingView } from './RingView'
import type { RingTarget } from '../audio/ring'
import { midiToLabel, ratioLabel, type ChordTone } from '../music/notes'

/**
 * The tuner.
 *
 * Two things a pitch pipe can't tell you: whether the note you sang back was
 * the one it gave you, and which part of the chord is dragging it flat. This
 * answers both, and it deliberately lives on its own screen — none of it
 * belongs on the instrument, and a director reaching for a pitch mid-song
 * should never have to look past it.
 *
 * Everything below updates through refs at about 30Hz. Routing a live cents
 * readout through React state would re-render the whole view thirty times a
 * second to move one marker.
 */

const CENTS_RANGE = 50

export type TuneMode = 'voice' | 'chord' | 'ring'

export interface TuneViewProps {
  /** What the pipe is currently set to — the chord mode's targets. */
  tones: ChordTone[]
  chordLabel: string
  a4: number
  useFlats: boolean
  micDeviceId: string | null
  /** The chord's ideal just ratios, for the ring test. */
  ringTargets: RingTarget[]
  /** Lifted, because the tray outside this view changes with it. */
  mode: TuneMode
  onMode: (m: TuneMode) => void
  /** Press and hold to hear the reference. Listening pauses while it sounds. */
  onReferenceDown: () => void
  onReferenceUp: () => void
}

const STATUS_TEXT: Record<AnalyzerStatus, string> = {
  idle: 'Not listening',
  requesting: 'Asking for the microphone…',
  listening: '',
  denied: 'Microphone blocked. Allow it in your browser settings.',
  error: 'Microphone unavailable.',
}

export function TuneView(props: TuneViewProps) {
  const { mode, onMode: setMode } = props
  const [status, setStatus] = useState<AnalyzerStatus>('idle')
  const [detail, setDetail] = useState<string | undefined>()
  const [sounding, setSounding] = useState(false)

  const voiceRef = useRef<VoiceReading | null>(null)
  const chordRef = useRef<ChordReading | null>(null)
  const analyzerRef = useRef<PitchAnalyzer | null>(null)

  // Rolling flat-drift: the average of everything actually sung since the
  // last reset. A chorus sagging over a run-through is a real and famously
  // hard-to-notice problem, and it costs two numbers to measure.
  const driftRef = useRef({ sum: 0, n: 0, since: Date.now() })
  const [, forceDrift] = useState(0)

  // Started from a layout effect rather than a passive one so the call still
  // sits inside the tap that opened this view — Safari only allows the
  // microphone prompt while a user gesture is live.
  //
  // The ring test does its own recording and needs the microphone to itself, so
  // the live analyser stands down entirely while that mode is up rather than
  // both of them holding a capture track.
  useLayoutEffect(() => {
    if (mode === 'ring') return
    const analyzer = new PitchAnalyzer(
      (r) => {
        voiceRef.current = r
        if (r.freq > 0 && r.clarity > 0.8 && Math.abs(r.cents) < 45) {
          const d = driftRef.current
          d.sum += r.cents
          d.n++
        }
      },
      (r) => {
        chordRef.current = r
      },
      (s, d) => {
        setStatus(s)
        setDetail(d)
      },
    )
    analyzerRef.current = analyzer
    analyzer.deviceId = props.micDeviceId
    analyzer.a4 = props.a4
    void analyzer.start(getAudio())
    return () => {
      analyzer.stop()
      analyzerRef.current = null
    }
    // Only the ring mode matters here. Changing the microphone or concert
    // pitch is handled below, without tearing the stream down and re-prompting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode === 'ring'])

  useEffect(() => {
    const a = analyzerRef.current
    if (!a) return
    a.a4 = props.a4
    a.targets = mode === 'chord' ? props.tones.map((t) => ({ freq: t.freq })) : []
    voiceRef.current = null
    chordRef.current = null
  }, [mode, props.tones, props.a4])

  /**
   * The reference is a latch here, not a hold.
   *
   * On the pipe you want a moment of pitch and your thumb back; in the tuner
   * you are matching a vowel or finding a chord by ear, and that wants a drone
   * you can leave running while both hands are free.
   */
  const toggleReference = useCallback(() => {
    if (sounding) {
      setSounding(false)
      props.onReferenceUp()
      // Long enough for the release tail to die away completely.
      analyzerRef.current?.mute(450)
      return
    }
    setSounding(true)
    // The reed is dead on pitch and, at arm's length, far louder than anyone
    // singing. Measuring through it would just report the app to itself.
    analyzerRef.current?.mute(3_600_000)
    props.onReferenceDown()
  }, [props, sounding])

  // Leaving the tuner with the drone running would strand a sounding note.
  useEffect(
    () => () => {
      props.onReferenceUp()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const resetDrift = useCallback(() => {
    driftRef.current = { sum: 0, n: 0, since: Date.now() }
    forceDrift((n) => n + 1)
  }, [])

  const bad = status === 'denied' || status === 'error'

  return (
    <div className="tune">
      <div className="segmented tune-modes" role="group" aria-label="What to listen for">
        <button
          className={`seg${mode === 'voice' ? ' is-on' : ''}`}
          onClick={() => setMode('voice')}
          aria-pressed={mode === 'voice'}
        >
          Voice
        </button>
        <button
          className={`seg${mode === 'chord' ? ' is-on' : ''}`}
          onClick={() => setMode('chord')}
          aria-pressed={mode === 'chord'}
        >
          Chord
        </button>
        <button
          className={`seg${mode === 'ring' ? ' is-on' : ''}`}
          onClick={() => setMode('ring')}
          aria-pressed={mode === 'ring'}
        >
          Ring
        </button>
      </div>

      {mode === 'ring' ? (
        <RingView
          targets={props.ringTargets}
          chordLabel={props.chordLabel}
          micDeviceId={props.micDeviceId}
        />
      ) : bad ? (
        <div className="tune-blocked">
          <p>{STATUS_TEXT[status]}</p>
          {detail && <p className="hint">{detail}</p>}
        </div>
      ) : mode === 'voice' ? (
        <VoicePanel
          readingRef={voiceRef}
          useFlats={props.useFlats}
          driftRef={driftRef}
          onResetDrift={resetDrift}
          paused={sounding}
        />
      ) : (
        <ChordPanel
          readingRef={chordRef}
          tones={props.tones}
          chordLabel={props.chordLabel}
          useFlats={props.useFlats}
          paused={sounding}
        />
      )}

      {/* The ring test brings its own controls, and a reference tone playing
          into a recording would be one more voice in the chord. */}
      {mode !== 'ring' && (
        <button
          className={`reference${sounding ? ' is-on' : ''}`}
          onClick={toggleReference}
          aria-pressed={sounding}
        >
          {sounding ? 'Sounding — tap to stop and listen' : 'Sound it'}
        </button>
      )}
    </div>
  )
}

// --- one voice --------------------------------------------------------------

function VoicePanel({
  readingRef,
  useFlats,
  driftRef,
  onResetDrift,
  paused,
}: {
  readingRef: React.RefObject<VoiceReading | null>
  useFlats: boolean
  driftRef: React.RefObject<{ sum: number; n: number; since: number }>
  onResetDrift: () => void
  paused: boolean
}) {
  const noteRef = useRef<HTMLDivElement>(null)
  const centsRef = useRef<HTMLDivElement>(null)
  const hzRef = useRef<HTMLDivElement>(null)
  const needleRef = useRef<HTMLDivElement>(null)
  const dialRef = useRef<HTMLDivElement>(null)
  const driftTextRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let raf = 0
    // The needle is smoothed on its way to the reading, not the reading on its
    // way to the needle: the number stays honest while the pointer stays calm.
    let shown = 0
    const frame = () => {
      raf = requestAnimationFrame(frame)
      const r = readingRef.current
      const note = noteRef.current
      if (!note || !centsRef.current || !hzRef.current || !needleRef.current) return

      const live = !!r && r.freq > 0 && !paused
      if (live && r) {
        note.textContent = midiToLabel(r.midi, useFlats)
        const cents = Math.max(-CENTS_RANGE, Math.min(CENTS_RANGE, r.cents))
        shown += (cents - shown) * 0.25
        centsRef.current.textContent = formatCents(r.cents)
        hzRef.current.textContent = `${r.freq.toFixed(1)} Hz`
        needleRef.current.style.left = `${50 + (shown / CENTS_RANGE) * 50}%`
        const tint = centsColour(Math.abs(r.cents))
        needleRef.current.style.background = tint
        centsRef.current.style.color = tint
        dialRef.current?.classList.toggle('is-locked', Math.abs(r.cents) <= IN_TUNE_CENTS)
      } else {
        note.textContent = '—'
        centsRef.current.textContent = paused ? 'listening paused' : 'sing a note'
        centsRef.current.style.color = ''
        hzRef.current.textContent = ''
        dialRef.current?.classList.remove('is-locked')
      }

      const d = driftRef.current
      if (driftTextRef.current) {
        if (d && d.n > 20) {
          const avg = d.sum / d.n
          const secs = Math.round((Date.now() - d.since) / 1000)
          const sign = avg > 0.05 ? '+' : avg < -0.05 ? '−' : ''
          driftTextRef.current.textContent =
            `${sign}${Math.abs(avg).toFixed(1)}¢ average over ` +
            `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
        } else if (driftTextRef.current) {
          driftTextRef.current.textContent = 'keep singing to measure drift'
        }
      }
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [readingRef, useFlats, driftRef, paused])

  return (
    <div className="tune-panel">
      <div className="tune-note" ref={noteRef}>
        —
      </div>
      <div className="tune-cents" ref={centsRef}>
        sing a note
      </div>

      <div className="dial" ref={dialRef}>
        <div className="dial-track">
          <span className="dial-tick dial-tick-mid" />
          <span className="dial-tick" style={{ left: '25%' }} />
          <span className="dial-tick" style={{ left: '75%' }} />
          <div className="dial-window" />
          <div className="dial-needle" ref={needleRef} />
        </div>
        <div className="dial-ends">
          <span>flat</span>
          <span>sharp</span>
        </div>
      </div>

      <div className="tune-hz" ref={hzRef} />

      <div className="drift">
        <div className="drift-label">Drift</div>
        <div className="drift-value" ref={driftTextRef}>
          keep singing to measure drift
        </div>
        <button className="chip drift-reset" onClick={onResetDrift}>
          Start again
        </button>
      </div>
    </div>
  )
}

// --- the whole chord --------------------------------------------------------

function ChordPanel({
  readingRef,
  tones,
  chordLabel,
  useFlats,
  paused,
}: {
  readingRef: React.RefObject<ChordReading | null>
  tones: ChordTone[]
  chordLabel: string
  useFlats: boolean
  paused: boolean
}) {
  const rowsRef = useRef<(HTMLDivElement | null)[]>([])
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let raf = 0
    const shown = tones.map(() => 0)
    const frame = () => {
      raf = requestAnimationFrame(frame)
      const r = readingRef.current
      wrapRef.current?.classList.toggle('is-ringing', !!r?.ringing && !paused)

      tones.forEach((_, i) => {
        const row = rowsRef.current[i]
        if (!row) return
        const needle = row.querySelector<HTMLElement>('.dial-needle')
        const value = row.querySelector<HTMLElement>('.part-cents')
        if (!needle || !value) return
        const flag = row.querySelector<HTMLElement>('.part-flag')
        const part = r?.parts[i]
        if (flag) {
          // Named on the row it applies to rather than as a caveat under the
          // whole panel, because in most voicings it applies to one part and
          // saying it about all four would be a lie.
          flag.textContent = part?.shared ? 'shared overtone' : ''
        }
        if (paused || !part || part.cents === null) {
          value.textContent = paused ? '—' : 'not heard'
          value.style.color = ''
          needle.style.opacity = '0.2'
          return
        }
        shown[i] += (part.cents - shown[i]) * 0.25
        needle.style.opacity = String(0.45 + 0.55 * part.strength)
        needle.style.left = `${50 + (shown[i] / CENTS_RANGE) * 50}%`
        const tint = centsColour(Math.abs(part.cents))
        needle.style.background = tint
        value.style.color = tint
        value.textContent = formatCents(part.cents)
      })
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [readingRef, tones, paused])

  return (
    <div className="tune-panel chord-panel" ref={wrapRef}>
      <div className="chord-title">{chordLabel}</div>

      <div className="chord-rows">
        {tones.map((t, i) => (
          <div
            className="chord-row"
            key={`${t.part}-${t.midi}`}
            ref={(el) => {
              rowsRef.current[i] = el
            }}
          >
            <div className="chord-row-head">
              <span className="part-name">{t.part}</span>
              <span className="part-note">
                {midiToLabel(t.midi, useFlats)}
                {/* The ratio, so a bari reading 31 cents below the piano can
                    see that 7/4 is exactly where they are supposed to be. */}
                {t.ratio && <em className="part-ratio">{ratioLabel(t.ratio)}</em>}
              </span>
              <span className="part-flag" />
              <span className="part-cents">not heard</span>
            </div>
            <div className="dial-track slim">
              <span className="dial-tick dial-tick-mid" />
              <div className="dial-window" />
              <div className="dial-needle" />
            </div>
          </div>
        ))}
      </div>

      <p className="hint tune-hint">
        {tones.length < 2
          ? 'Pick a chord on the pipe below and this shows every part at once.'
          : 'Sing it and hold. Green in the middle is locked in; the whole panel lights when all of it is.'}
      </p>
    </div>
  )
}

// --- shared -----------------------------------------------------------------

/** A real minus sign, and no "-0¢" for something that is simply in tune. */
function formatCents(c: number): string {
  const sign = c > 0.5 ? '+' : c < -0.5 ? '−' : ''
  return `${sign}${Math.abs(Math.round(c))}¢`
}

function centsColour(abs: number): string {
  if (abs <= IN_TUNE_CENTS) return '#6fd39b'
  if (abs <= 18) return '#ffb23c'
  return '#e88b6d'
}
