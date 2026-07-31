import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * The tour.
 *
 * Not a carousel of screenshots. Screenshots are the easy thing to build and
 * the thing nobody remembers: an interface explained somewhere other than where
 * it lives has to be translated back before it can be used, and the translating
 * is the part people fail at. So this is a light on the real control, on the
 * real screen, with the real app still working underneath — the whole overlay is
 * `pointer-events: none` apart from the card. Every step names one thing to try,
 * and ticks itself off the moment you actually do it.
 *
 * Three rules it holds to, in order of how often they get broken:
 *
 * 1. Never trap. Next is always there whether or not you did the thing, Back
 *    goes back, Escape leaves, and closing is one tap from any step. A tour you
 *    cannot walk out of is an interrogation.
 * 2. One idea per step, and seven steps. Every extra card is another chance to
 *    give up, and the tour that gets finished teaches more than the thorough one
 *    that gets abandoned on card four. Custom stacks, hall mode and concert
 *    pitch are all deliberately absent — they are discoverable in place, and
 *    this is a spine, not a manual.
 * 3. Nothing is a prerequisite. Steps whose lesson you already know — breath
 *    already on, chord already picked — quietly drop their prompt instead of
 *    asking you to do something you have done.
 */

/** How far past the target the clear middle of the veil reaches. */
const HOLE = 1.18
/** Between the spotlit thing and the card that talks about it. */
const GAP = 18
/** How close the card may come to the edge of the screen. */
const EDGE = 12
/**
 * How long the tick is left on screen before the step gives way.
 *
 * Long enough to be read as a reward rather than as the card being yanked away.
 */
const TICK_MS = 900

export interface TourSignals {
  view: 'pipe' | 'tune'
  noteIndex: number
  /** Anything at all coming out of the speaker because of the middle. */
  sounding: boolean
  pitchMode: 'note' | 'chord' | 'custom'
  /**
   * The microphone is open, past the room measurement, and actually hearing.
   *
   * Not "the Breath switch is on", which is true the instant it is tapped and
   * therefore also true while the phone's own permission sheet is sitting over
   * the whole screen. Ticking a step off behind a system prompt and moving on
   * underneath it is the tour talking to itself: by the time the prompt is
   * answered the card that asked for this is two steps gone. So the step waits
   * for the thing it actually promised — a microphone that is listening.
   */
  breathReady: boolean
  setlistOpen: boolean
}

interface Spot {
  /** Where the light goes. Missing on screen is fine — the card just centres. */
  sel: string
  /** Fraction of the element to light, about its middle. */
  scale?: number
  round?: boolean
}

interface Step {
  id: string
  title: string
  body: string
  spot?: Spot
  /** The one thing to try here. Only shown when it isn't already true. */
  todo?: string
  /**
   * Called with (now, whenTheStepStarted). Called with the start snapshot for
   * both arguments to ask "was this already true when we got here?", which is
   * how a step decides whether it has anything to ask for.
   */
  done?: (now: TourSignals, start: TourSignals) => boolean
  /** Dropped from the tour entirely when this is false. */
  when?: () => boolean
}

/** No microphone, no point promising the user they can blow at their phone. */
function hasMic(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  )
}

const STEPS: Step[] = [
  {
    id: 'pick',
    title: 'Pick your note',
    body: 'Spin the pipe, or tap a hole to jump to it. Whatever sits in the middle is the pitch you get — thirteen of them, F to F.',
    todo: 'Spin it to another note',
    spot: { sel: '.disc-canvas', round: true },
    done: (n, s) => n.noteIndex !== s.noteIndex,
  },
  {
    id: 'sound',
    title: 'Sound it',
    body: 'Hold the middle and it plays for as long as you hold it. Tap the middle instead and it stays on by itself until you tap it again.',
    todo: 'Hold the middle',
    spot: { sel: '.disc-canvas', scale: 0.36, round: true },
    done: (n) => n.sounding,
  },
  {
    id: 'chord',
    title: 'Or the whole chord',
    body: 'Chord builds a four-part voicing under the note you picked, tuned the way barbershop actually rings. Each voice’s note appears below the pipe, ready to read out.',
    todo: 'Tap Chord',
    spot: { sel: '[data-tour="kinds"]' },
    done: (n) => n.pitchMode === 'chord',
  },
  {
    id: 'breath',
    title: 'Blow it like the real thing',
    body: 'Turn on Breath and blow at your phone. It speaks when you do and as hard as you do — and you’ll see the air stream across the pipe.',
    todo: 'Turn on Breath',
    spot: { sel: '[data-tour="breath"]' },
    done: (n) => n.breathReady,
    when: hasMic,
  },
  {
    id: 'setlist',
    title: 'Keep your songs',
    body: 'Save a starting pitch under a song title and next rehearsal it’s one tap. The whole book travels as a link, so a section can carry the director’s list.',
    todo: 'Open the Setlist',
    spot: { sel: '[data-tour="setlist"]', round: true },
    done: (n) => n.setlistOpen,
  },
  {
    id: 'tuner',
    title: 'Then hear how it went',
    body: 'The tuner listens back. It shows a singer how close they are, and it scores how well a whole chord locks and rings.',
    todo: 'Open the Tuner',
    spot: { sel: '[data-tour="tuner"]' },
    done: (n) => n.view === 'tune',
  },
  {
    id: 'end',
    title: 'That’s the whole instrument',
    body: 'Everything else lives in Settings — concert pitch, sharps or flats, how eager the breath trigger is. The ? at the top brings this back any time.',
  },
]

export interface TourProps {
  open: boolean
  /** A sheet is over the app. The tour stands aside rather than fighting it. */
  hidden?: boolean
  signals: TourSignals
  onClose: () => void
}

export function Tour({ open, hidden, signals, onClose }: TourProps) {
  const [steps, setSteps] = useState<Step[]>(STEPS)
  const [i, setI] = useState(0)
  /** Which step's ask has just been carried out, for the beat before the tour
   *  moves on. Held as an index rather than a flag so that stepping away from a
   *  step clears its tick by construction. */
  const [tickedStep, setTickedStep] = useState(-1)

  const veilRef = useRef<HTMLDivElement>(null)
  const ringRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  /** The pause between the tick and the next step. Held here rather than in an
   *  effect cleanup: the effect that starts it re-runs on the very next render,
   *  and a cleanup would cancel the timer it had just set. */
  const advanceRef = useRef(0)
  /** Steps carried out at some point during this run of the tour. */
  const carriedRef = useRef(new Set<string>())

  const step = steps[Math.min(i, steps.length - 1)]
  const last = i >= steps.length - 1

  /**
   * What the step wants, worked out on arrival.
   *
   * Derived during render rather than parked in state, and the difference is a
   * bug rather than a preference. An effect that stores this runs *after* the
   * render in which the step changed, so for one render the guard below is
   * still answering for the step you just left — and pressing Back landed on a
   * card whose thing you had plainly already done, watched it decide the ask
   * had just been satisfied, and bounced you forward again. Computing it beside
   * the step index means the two can never disagree.
   */
  const snapRef = useRef<{ i: number; start: TourSignals; asking: boolean }>({
    i: -1,
    start: signals,
    asking: false,
  })
  if (open && snapRef.current.i !== i) {
    window.clearTimeout(advanceRef.current)
    snapRef.current = {
      i,
      // Each step takes its own snapshot, so "changed" always means changed
      // since you were asked — not since the tour began.
      start: signals,
      asking: Boolean(
        step?.todo &&
          step.done &&
          // Going back never re-demands something already done, and neither
          // does arriving at a step whose lesson was true before you got here.
          !carriedRef.current.has(step.id) &&
          !step.done(signals, signals),
      ),
    }
  }
  const asking = open && snapRef.current.asking
  const ticked = tickedStep === i

  // Availability is settled once, on the way in. A microphone that appears
  // halfway through would otherwise renumber the steps under the user's thumb.
  useEffect(() => {
    if (!open) return
    setSteps(STEPS.filter((s) => !s.when || s.when()))
    setI(0)
    setTickedStep(-1)
    carriedRef.current = new Set()
    // The -1 is the part that matters — it forces the next render to take a
    // fresh snapshot for step zero.
    snapRef.current = { i: -1, start: signals, asking: false }
  }, [open])

  useEffect(() => () => window.clearTimeout(advanceRef.current), [])

  const next = useCallback(() => {
    setI((n) => {
      if (n >= steps.length - 1) {
        onClose()
        return n
      }
      return n + 1
    })
  }, [onClose, steps.length])

  // No deps: this has to run after every render of the app above it, because
  // any of them might be the one where the user did the thing.
  useEffect(() => {
    if (!open || hidden || ticked || !asking || !step?.done) return
    if (!step.done(signals, snapRef.current.start)) return
    carriedRef.current.add(step.id)
    setTickedStep(i)
    advanceRef.current = window.setTimeout(next, TICK_MS)
  })

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  /**
   * Where the light and the card go.
   *
   * Measured every frame rather than on a step change, because the thing being
   * lit moves: picking Chord grows a row of chord types and shoves the tray up
   * underneath it, and a spotlight that stays where the button used to be is
   * worse than none. Nothing is written unless a number actually changed, so
   * the steady state costs one getBoundingClientRect a frame.
   */
  useEffect(() => {
    if (!open || hidden) return
    let raf = 0
    let last = ''
    let settled = false

    const frame = () => {
      raf = requestAnimationFrame(frame)
      const veil = veilRef.current
      const ring = ringRef.current
      const card = cardRef.current
      if (!veil || !card) return

      const vw = window.innerWidth
      const vh = window.innerHeight
      const cw = card.offsetWidth
      const ch = card.offsetHeight

      const el = step?.spot ? document.querySelector(step.spot.sel) : null
      let r: { x: number; y: number; w: number; h: number } | null = null
      if (el) {
        const b = el.getBoundingClientRect()
        const k = step!.spot!.scale ?? 1
        r = {
          x: b.left + b.width / 2,
          y: b.top + b.height / 2,
          w: b.width * k,
          h: b.height * k,
        }
      }

      const key = r
        ? `${r.x | 0}.${r.y | 0}.${r.w | 0}.${r.h | 0}.${cw}.${ch}.${vw}.${vh}`
        : `none.${cw}.${ch}.${vw}.${vh}`
      if (key === last) return
      last = key

      if (r) {
        const rx = Math.max(r.w * HOLE, 88)
        const ry = Math.max(r.h * HOLE, 88)
        // Soft, because this app does not do hard-edged boxes. A cut-out with a
        // crisp rim draws a rectangle nobody asked to see; a pool of shade
        // reads as attention rather than as geometry.
        veil.style.background = `radial-gradient(ellipse ${rx}px ${ry}px at ${r.x}px ${r.y}px, rgba(3,8,6,0) 0%, rgba(3,8,6,0) 42%, rgba(3,8,6,0.46) 74%, rgba(3,8,6,0.62) 100%)`
        if (ring) {
          ring.style.opacity = '1'
          ring.style.width = `${Math.round(r.w) + 14}px`
          ring.style.height = `${Math.round(r.h) + 14}px`
          ring.style.borderRadius = step!.spot!.round ? '50%' : '18px'
          ring.style.transform = `translate(${Math.round(r.x)}px, ${Math.round(r.y)}px) translate(-50%, -50%)`
        }
      } else {
        veil.style.background = 'rgba(3,8,6,0.62)'
        if (ring) ring.style.opacity = '0'
      }

      // Under the target if it fits, over it if not, and beside it when neither
      // works — a phone on its side has a disc as tall as the screen and no
      // room above or below at all. The sideways fallback measures from the
      // middle of the target rather than its edge, so what is actually being
      // pointed at stays clear even when the card has to lie over the rim.
      let top: number
      let left: number
      if (!r) {
        top = (vh - ch) / 2
        left = (vw - cw) / 2
      } else {
        const under = vh - (r.y + r.h / 2) - GAP - EDGE >= ch
        const over = r.y - r.h / 2 - GAP - EDGE >= ch
        if (under || over) {
          top = under ? r.y + r.h / 2 + GAP : r.y - r.h / 2 - GAP - ch
          left = r.x - cw / 2
        } else {
          left = vw - r.x >= r.x ? vw - EDGE - cw : EDGE
          top = r.y - ch / 2
        }
      }
      top = Math.min(Math.max(EDGE, top), Math.max(EDGE, vh - ch - EDGE))
      left = Math.min(Math.max(EDGE, left), Math.max(EDGE, vw - cw - EDGE))

      // The first placement is a jump, every one after it is a glide: a card
      // that slides in from the top-left corner on open looks like a bug.
      if (!settled) card.style.transition = 'none'
      card.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`
      if (!settled) {
        settled = true
        requestAnimationFrame(() => {
          if (cardRef.current) cardRef.current.style.transition = ''
        })
      }
    }

    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [open, hidden, step])

  if (!open) return null

  return (
    <div className={`tour${hidden ? ' is-away' : ''}`} data-step={step?.id}>
      <div className="tour-veil" ref={veilRef} aria-hidden="true" />
      <div className="tour-ring" ref={ringRef} aria-hidden="true" />

      <div
        className="tour-card"
        ref={cardRef}
        role="dialog"
        aria-label="How Pitch Piper works"
      >
        <button className="tour-x" onClick={onClose} aria-label="Close the tour">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7 7l10 10M17 7L7 17" />
          </svg>
        </button>

        <div className="tour-step" aria-live="polite">
          <span className="tour-count">
            Step {i + 1} of {steps.length}
          </span>
          <h2 className="tour-title">{step?.title}</h2>
          <p className="tour-body">{step?.body}</p>
          {asking && step?.todo && (
            <div className={`tour-todo${ticked ? ' is-done' : ''}`}>
              <span className="tour-tick" aria-hidden="true">
                {ticked ? '✓' : '→'}
              </span>
              {step.todo}
            </div>
          )}
        </div>

        <div className="tour-foot">
          <button
            className="tour-back"
            onClick={() => setI((n) => Math.max(0, n - 1))}
            disabled={i === 0}
          >
            Back
          </button>
          <div className="tour-dots" aria-hidden="true">
            {steps.map((s, n) => (
              <span
                key={s.id}
                className={`tour-dot${n === i ? ' is-on' : n < i ? ' is-past' : ''}`}
              />
            ))}
          </div>
          <button className="tour-next" onClick={next}>
            {last ? 'Start singing' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  )
}

// --- the way in ---------------------------------------------------------------

export interface TourNudgeProps {
  /** 'first' is an offer; 'stuck' is the same offer, worded for someone who
   *  has been sitting on the pipe for half a minute without touching it. */
  kind: 'first' | 'stuck'
  onTake: () => void
  onDismiss: () => void
}

/**
 * The tap on the shoulder.
 *
 * Everything about this is an argument against a first-run modal. A modal is
 * shown before anyone has a question, blocks the thing they opened the app to
 * do, and gets dismissed unread — which then counts, in the numbers, as
 * onboarding delivered. This is a corner of the screen, points at the button
 * that will still be there afterwards, and goes away for good the first time
 * it is waved off.
 */
export function TourNudge({ kind, onTake, onDismiss }: TourNudgeProps) {
  return (
    <div className="tour-nudge" role="status">
      <button className="tour-nudge-take" onClick={onTake}>
        {kind === 'stuck' ? 'Not sure where to start?' : 'New here?'}{' '}
        <strong>Take the tour</strong>
      </button>
      <button
        className="tour-nudge-x"
        onClick={onDismiss}
        aria-label="No thanks"
        title="No thanks"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7 7l10 10M17 7L7 17" />
        </svg>
      </button>
    </div>
  )
}

export function HelpIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M9.4 9.3a2.7 2.7 0 0 1 5.2.9c0 1.8-2.6 2.2-2.6 4" />
      <path d="M12 17.3h.01" />
    </svg>
  )
}
