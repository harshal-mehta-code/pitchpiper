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
import { NeedsChord } from './NeedsChord'
import { Meter, centsColour, formatCents } from './Meter'

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

/**
 * Named for what you are looking at, not for what is sounding.
 *
 * The middle one was "Chord" until the tray below it also grew a "Chord" — two
 * controls a thumb apart, same word, different jobs. "Parts" is what it
 * actually shows, and it is what a director would say out loud.
 */
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
  /** The bass of that chord in Hz, as the pipe would sound it. */
  rootHz: number
  /** True when the target is a hand-built stack rather than a named chord. */
  isCustom: boolean
  /** Lifted, because the tray outside this view changes with it. */
  mode: TuneMode
  onMode: (m: TuneMode) => void
  /** Press and hold to hear the reference. Listening pauses while it sounds. */
  onReferenceDown: () => void
  onReferenceUp: () => void
  /**
   * Take me to the pipe.
   *
   * Building a custom set of notes genuinely needs the disc, and that is the
   * one thing in here that cannot be done in place. Where the app used to say
   * "go and do this on the other screen" it now offers to go there — an
   * instruction to navigate is not an interface.
   */
  onGoToPipe: () => void
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
          Parts
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
          rootHz={props.rootHz}
          chordLabel={props.chordLabel}
          micDeviceId={props.micDeviceId}
          isCustom={props.isCustom}
          onGoToPipe={props.onGoToPipe}
        />
      ) : bad ? (
        <div className="plate tune-blocked">
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
          useFlats={props.useFlats}
          paused={sounding}
          isCustom={props.isCustom}
          onGoToPipe={props.onGoToPipe}
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
  const hzRef = useRef<HTMLSpanElement>(null)
  const needleRef = useRef<HTMLDivElement>(null)
  const meterRef = useRef<HTMLDivElement>(null)
  const driftTextRef = useRef<HTMLSpanElement>(null)

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
        needleRef.current.style.opacity = '1'
        const tint = centsColour(Math.abs(r.cents))
        needleRef.current.style.background = tint
        centsRef.current.style.color = tint
        meterRef.current?.classList.toggle('is-locked', Math.abs(r.cents) <= IN_TUNE_CENTS)
      } else {
        note.textContent = '—'
        centsRef.current.textContent = paused ? 'listening paused' : 'sing a note'
        centsRef.current.style.color = ''
        hzRef.current.textContent = ''
        needleRef.current.style.opacity = '0.15'
        meterRef.current?.classList.remove('is-locked')
      }

      const d = driftRef.current
      if (driftTextRef.current) {
        if (d && d.n > 20) {
          const avg = d.sum / d.n
          const secs = Math.round((Date.now() - d.since) / 1000)
          const sign = avg > 0.05 ? '+' : avg < -0.05 ? '\u2212' : ''
          driftTextRef.current.textContent =
            `${sign}${Math.abs(avg).toFixed(1)}\u00a2 over ` +
            `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
        } else {
          driftTextRef.current.textContent = 'keep singing'
        }
      }
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [readingRef, useFlats, driftRef, paused])

  return (
    <div className="plate voice-plate">
      <div className="tune-note" ref={noteRef}>
        \u2014
      </div>
      <div className="tune-cents" ref={centsRef}>
        sing a note
      </div>

      <Meter ref={meterRef} needleRef={needleRef} size="lg" />
      <div className="meter-ends">
        <span>flat</span>
        <span className="tune-hz" ref={hzRef} />
        <span>sharp</span>
      </div>

      {/* Drift belongs to this panel rather than beside it: it is the same
          measurement, averaged. A rule and a row, not a second card. */}
      <div className="plate-foot">
        <span className="engraved">Drift</span>
        <span className="foot-value" ref={driftTextRef}>
          keep singing
        </span>
        <button className="foot-action" onClick={onResetDrift}>
          Reset
        </button>
      </div>
    </div>
  )
}

// --- the whole chord --------------------------------------------------------

function ChordPanel({
  readingRef,
  tones,
  useFlats,
  paused,
  isCustom,
  onGoToPipe,
}: {
  readingRef: React.RefObject<ChordReading | null>
  tones: ChordTone[]
  useFlats: boolean
  paused: boolean
  isCustom: boolean
  onGoToPipe: () => void
}) {
  const rowsRef = useRef<(HTMLDivElement | null)[]>([])
  const wrapRef = useRef<HTMLDivElement>(null)
  const offsetRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    let raf = 0
    const shown = tones.map(() => 0)
    const frame = () => {
      raf = requestAnimationFrame(frame)
      const r = readingRef.current
      // Proportional rather than on or off. Three parts locked and one out is
      // most of the way to a ringing chord, and a light with two states cannot
      // say so — it stays dark until suddenly it doesn't.
      wrapRef.current?.style.setProperty(
        '--lock',
        (paused ? 0 : (r?.lock ?? 0)).toFixed(3),
      )
      wrapRef.current?.classList.toggle('is-ringing', !!r?.ringing && !paused)

      if (offsetRef.current) {
        // The collective drift, said once and quietly. Everyone being flat
        // together is a fact about the room, not a fault in four singers, so it
        // is reported here rather than on all four rows at once.
        // Two parts at least. One voice says nothing about where a chord is —
        // it might be the part that is out.
        const heard = r?.parts.filter((p) => p.cents !== null).length ?? 0
        const off = r && heard >= 2 && !paused ? r.offset : 0
        offsetRef.current.textContent =
          Math.abs(off) >= 4
            ? `${Math.abs(Math.round(off))}\u00a2 ${off < 0 ? 'flat' : 'sharp'} together`
            : ''
      }

      tones.forEach((_, i) => {
        const row = rowsRef.current[i]
        if (!row) return
        const needle = row.querySelector<HTMLElement>('.meter-needle')
        const value = row.querySelector<HTMLElement>('.part-cents')
        const sub = row.querySelector<HTMLElement>('.part-sub')
        if (!needle || !value || !sub) return
        const part = r?.parts[i]

        if (paused || !part || part.cents === null) {
          row.classList.add('is-quiet')
          value.textContent = '\u2014'
          value.style.color = ''
          sub.textContent = paused ? 'paused' : 'not heard'
          sub.classList.add('is-flagged')
          needle.style.opacity = '0.14'
          needle.style.left = '50%'
          return
        }

        row.classList.remove('is-quiet')
        // The line under the name carries whichever of the two is worth saying.
        // An octave error and a shared partial are both caveats on the number
        // beside them; the just ratio only matters when there is neither.
        const flag = part.octave
          ? part.octave < 0
            ? 'an octave low'
            : 'an octave high'
          : part.shared
            ? 'shared overtone'
            : ''
        sub.textContent = flag || (sub.dataset.ratio ?? '')
        sub.classList.toggle('is-flagged', !!flag)

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

  if (tones.length < 2) {
    return (
      <div className="plate">
        <NeedsChord isCustom={isCustom} onGoToPipe={onGoToPipe} />
      </div>
    )
  }

  return (
    <div className="plate chord-plate" ref={wrapRef}>
      <div className="plate-head">
        <span className="engraved">Parts</span>
        <span className="chord-offset" ref={offsetRef} />
      </div>

      <div className="chord-rows">
        {tones.map((t, i) => (
          <div
            className="chord-row is-quiet"
            key={`${t.part}-${t.midi}`}
            ref={(el) => {
              rowsRef.current[i] = el
            }}
          >
            <div className="row-id">
              <span className="row-what">
                <span className="part-name">{t.part}</span>
                <span className="part-note">{midiToLabel(t.midi, useFlats)}</span>
              </span>
              {/* Kept on the element too, so the loop can put the ratio back
                  when the flag that displaced it goes away. */}
              <span className="part-sub" data-ratio={t.ratio ? ratioLabel(t.ratio) : ''}>
                {t.ratio ? ratioLabel(t.ratio) : ''}
              </span>
            </div>
            <Meter size="sm" />
            <span className="part-cents">\u2014</span>
          </div>
        ))}
      </div>
    </div>
  )
}
