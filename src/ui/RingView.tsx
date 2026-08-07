import { useCallback, useEffect, useRef, useState } from 'react'
import { getAudio } from '../audio/engine'
import { MAX_SECONDS, MIN_SECONDS, SnippetRecorder, toAudioBuffer } from '../audio/recorder'
import { analyseRing, type Recording, type RingReport, type RingTarget } from '../audio/ring'
import { NeedsChord } from './NeedsChord'
import { centsColour, formatCents, lockColour } from './Meter'
import { MIC_TEXT } from './micText'

/**
 * The ring test: sing a chord at it, get told whether it rang and who broke it.
 *
 * Recorded rather than live, and deliberately so. Ringing is a property of a
 * chord being *held* — it needs a couple of seconds of steady sound to exist at
 * all — and a live readout of it would be a number twitching at you while
 * you're trying to sing. Sing first, look afterwards.
 */

export interface RingViewProps {
  targets: RingTarget[]
  /**
   * Where the pipe put the bass. Seeds the search for where the bass actually
   * landed — which is a different number, and the one everything is measured
   * against.
   */
  rootHz: number
  chordLabel: string
  micDeviceId: string | null
  isCustom: boolean
  onGoToPipe: () => void
}

type Phase = 'idle' | 'recording' | 'working' | 'done' | 'failed'

export function RingView({
  targets,
  rootHz,
  chordLabel,
  micDeviceId,
  isCustom,
  onGoToPipe,
}: RingViewProps) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<RingReport | null>(null)
  const [playing, setPlaying] = useState(false)

  const recorderRef = useRef<SnippetRecorder | null>(null)
  const takeRef = useRef<Recording | null>(null)
  const sourceRef = useRef<AudioBufferSourceNode | null>(null)
  const meterRef = useRef<HTMLDivElement>(null)
  const clockRef = useRef<HTMLDivElement>(null)

  const finish = useCallback(() => {
    const rec = recorderRef.current
    if (!rec?.recording) return
    const take = rec.stop()
    takeRef.current = take
    if (!take || take.samples.length / take.sampleRate < MIN_SECONDS) {
      setError('That was too short — give it a couple of seconds of chord.')
      setPhase('failed')
      return
    }
    setPhase('working')
    // Out of the click handler, so the button repaints as pressed before a
    // few hundred milliseconds of arithmetic locks up the main thread.
    window.setTimeout(() => {
      setReport(analyseRing(take, targets, rootHz))
      setPhase('done')
    }, 30)
  }, [targets, rootHz])

  const begin = useCallback(() => {
    setError(null)
    setReport(null)
    takeRef.current = null
    const ctx = getAudio()
    const rec = recorderRef.current ?? new SnippetRecorder()
    recorderRef.current = rec
    setPhase('recording')
    void rec.start(ctx, micDeviceId).then((r) => {
      if (r.ok) return
      setError(
        r.kind === 'denied'
          ? MIC_TEXT.denied
          : (r.detail ?? 'Could not open the microphone.'),
      )
      setPhase('failed')
    })
  }, [micDeviceId])

  // Level meter and the clock, plus the hard stop at the length limit.
  useEffect(() => {
    if (phase !== 'recording') return
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const rec = recorderRef.current
      if (!rec) return
      if (meterRef.current) {
        meterRef.current.style.transform = `scaleX(${Math.min(1, rec.level * 2.4).toFixed(3)})`
      }
      if (clockRef.current) clockRef.current.textContent = `${rec.elapsed.toFixed(1)}s`
      if (rec.elapsed >= MAX_SECONDS) finish()
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [phase, finish])

  useEffect(
    () => () => {
      recorderRef.current?.cancel()
      try {
        sourceRef.current?.stop()
      } catch {
        /* already finished */
      }
    },
    [],
  )

  const play = useCallback(() => {
    const take = takeRef.current
    if (!take) return
    const ctx = getAudio()
    try {
      sourceRef.current?.stop()
    } catch {
      /* already finished */
    }
    if (playing) {
      setPlaying(false)
      return
    }
    const src = ctx.createBufferSource()
    src.buffer = toAudioBuffer(ctx, take)
    // Straight out, not through the reed bus: this is a recording of people,
    // and hall mode's saturation would be lying about what they sounded like.
    src.connect(ctx.destination)
    src.onended = () => setPlaying(false)
    src.start()
    sourceRef.current = src
    setPlaying(true)
  }, [playing])

  if (phase === 'recording') {
    return (
      <div className="ring">
        <div className="plate ring-recording">
          <div className="ring-clock" ref={clockRef}>
            0.0s
          </div>
          <div className="level">
            <div className="level-fill" ref={meterRef} />
          </div>
          <p className="hint">Hold the chord. It stops itself at {MAX_SECONDS}s.</p>
        </div>
        <button className="reference is-on" onClick={finish}>
          Stop and look
        </button>
      </div>
    )
  }

  if (phase === 'working') {
    return (
      <div className="ring">
        <div className="plate ring-working">Listening back…</div>
      </div>
    )
  }

  return (
    <div className="ring">
      {phase === 'done' && report && (
        <Report report={report} onPlay={play} playing={playing} />
      )}

      {phase !== 'done' && (
        <div className="plate ring-intro">
          {/* Only worth saying once there is something to sing. Told to sing a
              single note — or worse, told to sing the words "tap holes on the
              pipe" — the line below reads as nonsense. */}
          {targets.length < 2 ? (
            <NeedsChord isCustom={isCustom} onGoToPipe={onGoToPipe} />
          ) : (
            <>
              <h2>Did it ring?</h2>
              <p>
                Sing{' '}
                <strong>
                  {isCustom ? `all ${targets.length} notes together` : chordLabel}
                </strong>{' '}
                and hold it.
              </p>
            </>
          )}
          {error && <p className="ring-error">{error}</p>}
        </div>
      )}

      <button
        className="reference"
        onClick={begin}
        disabled={targets.length < 2}
      >
        {phase === 'done' ? 'Go again' : 'Record'}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------

function Report({
  report,
  onPlay,
  playing,
}: {
  report: RingReport
  onPlay: () => void
  playing: boolean
}) {
  if (report.problem) {
    return (
      <div className="plate ring-intro">
        <p className="ring-error">{report.problem}</p>
      </div>
    )
  }

  const worst = report.parts
    .filter((p) => p.cents !== null)
    .sort((a, b) => Math.abs(b.cents ?? 0) - Math.abs(a.cents ?? 0))[0]
  const blame =
    worst && Math.abs(worst.cents ?? 0) > 8
      ? `${worst.part} is ${formatCents(worst.cents ?? 0)} off the bass.`
      : null

  // Loudest first, so the rungs that actually matter are at the top.
  const shown = report.rungs
    .filter((r) => r.energy > 0.05)
    .sort((a, b) => b.n - a.n)

  return (
    <div className="ring-report">
      {/* The answer, in the words somebody would use out loud.
          There was a 0-100 score here in forty-four point type. A number invites
          you to improve the number, and four seconds of four people is not
          accurate to a point — "close, nearly locked" is both the honest
          resolution of this measurement and what a director would actually say.
          The score still decides which sentence this is; it just stopped being
          the sentence. */}
      <div className="plate ring-score">
        <div className={`ring-verdict ${band(report.score)}`}>
          {verdict(report.score)}
        </div>
        {blame && <div className="ring-blame">{blame}</div>}
      </div>

      <div className="plate ladder">
        <div className="plate-head">
          <span className="engraved">Overtones of the bass</span>
          <span className="chord-offset">{Math.round(report.rootHz)} Hz</span>
        </div>
        {shown.map((r) => {
          // Two parts *measured* here, not two parts nominally meeting here.
          // A rung where one of the pair was inaudible has nothing to say about
          // beating, and saying it anyway is how silence came to read as a lock.
          const shared = r.heard >= 2
          return (
            <div className={`rung${shared ? ' is-shared' : ''}`} key={r.n}>
              <span className="rung-n">×{r.n}</span>
              <span className="rung-hz">{Math.round(r.freq)}</span>
              <span className="rung-bar">
                <span
                  className="rung-fill"
                  style={{
                    width: `${Math.round(r.energy * 100)}%`,
                    background: shared ? lockColour(r.lock) : 'var(--brass-faint)',
                  }}
                />
              </span>
              <span className="rung-who">
                {shared ? r.parts.map((p) => p.part).join(' + ') : r.parts[0]?.part ?? ''}
              </span>
              <span className="rung-state">
                {shared
                  ? r.lock > 0.8
                    ? 'locked'
                    : `${r.beatHz.toFixed(1)}/s`
                  : ''}
              </span>
            </div>
          )
        })}
      </div>

      <div className="plate">
        <div className="plate-head">
          <span className="engraved">Each part, against the bass</span>
        </div>
        <div className="ring-parts">
          {report.parts.map((p) => (
            <div className="ring-part" key={p.part}>
              <span className="part-name">{p.part}</span>
              <span
                className="ring-part-cents"
                style={{
                  color: p.cents === null ? undefined : centsColour(Math.abs(p.cents)),
                }}
              >
                {p.cents === null ? 'not heard' : formatCents(p.cents)}
              </span>
              {p.cents !== null && p.steadiness < 0.55 && (
                <span className="ring-part-flag">wandering</span>
              )}
            </div>
          ))}
        </div>
      </div>

      <button className={`chip wide${playing ? ' is-on' : ''}`} onClick={onPlay}>
        {playing ? 'Stop' : `Hear it back (${report.duration.toFixed(1)}s)`}
      </button>
    </div>
  )
}

function verdict(score: number): string {
  if (score >= 85) return 'That rang.'
  if (score >= 70) return 'Close — nearly locked.'
  if (score >= 50) return 'Fighting itself.'
  if (score >= 30) return 'Not locking yet.'
  return 'A long way from locking.'
}

function band(score: number): string {
  if (score >= 85) return 'is-good'
  if (score >= 50) return 'is-mid'
  return 'is-poor'
}
