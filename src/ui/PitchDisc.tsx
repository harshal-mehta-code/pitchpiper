import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { playDetentClick } from '../audio/engine'
import { stackHole } from '../music/notes'

/**
 * The whole app is one brass disc you spin with your thumb.
 *
 * It's rendered to canvas rather than the DOM because the metal needs a conic
 * sheen and a brushed grain to read as metal, and because rotating a ring of
 * engraved glyphs at 60fps in the DOM is a bad time. The disc face is
 * pre-rendered once to an offscreen canvas; each frame just rotates and blits
 * it, then paints the live glow on top.
 */

const NOTE_COUNT = 13
const STEP = (Math.PI * 2) / NOTE_COUNT

/** Below this angular velocity we stop coasting and let the detent grab. */
const SNAP_VELOCITY = 0.0028
const FRICTION = 0.945

/**
 * Fraction of the canvas the disc itself occupies. The margin is where the
 * drop shadow and the amber halo live — both are painted into the canvas
 * rather than applied as CSS filters, because a `filter: drop-shadow` on a
 * surface that repaints every frame is a real cost on a phone.
 */
const DISC_FILL = 0.88

/**
 * Whether to draw the air at all.
 *
 * A screenful of drifting smoke is exactly the kind of ambient motion someone
 * with vestibular sensitivity turns that setting on to be rid of. The breath
 * meter below the disc still reports what the microphone is hearing, so nothing
 * is lost but the weather.
 */
function wantsStillness(): boolean {
  return (
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/**
 * Backing-store scale for the air layer.
 *
 * Well below the screen's, and lower again once the stream got dense enough to
 * be worth looking at. Everything drawn there is a soft gradient with no edge
 * to resolve, so the only thing a finer backing store buys is fill rate spent —
 * and fill rate is the entire budget here. Dropping it is invisible; the frame
 * it saves is not.
 */
const AIR_DPR = 0.7

/** How long the ripple under a tapped hole lasts. */
const PULSE_MS = 480

/**
 * A press shorter than this is a tap, and a tap latches the note on.
 *
 * Generous on purpose: someone reaching for a quick reference pitch and holding
 * it for a fifth of a second meant to tap, and getting a note that stops the
 * instant their thumb lifts would feel broken. Anything longer is plainly a
 * hold and behaves like one.
 */
const TAP_MS = 260

/**
 * How many puffs of air can be in flight at full blow.
 *
 * Fewer than the old streaks, and much bigger. Volume comes from overlap, not
 * from count, and each of these covers a hundred times the area — the budget
 * here is fill rate on a phone, not particle bookkeeping.
 */
const MAX_MOTES = 72

export interface PitchDiscProps {
  noteIndex: number
  onNoteIndexChange: (index: number) => void
  labels: string[]
  centerLabel: string
  centerSub: string
  /** 0..1 loudness, drives the bloom. Read every frame, never re-renders. */
  glowRef: RefObject<number>
  hubActive: boolean
  onHubDown: () => void
  /**
   * `quick` is true when the press was short enough to read as a tap rather
   * than a hold. The middle of the pipe is the one place that makes sound, and
   * it does both jobs: hold it for as long as you want the note, or tap it and
   * leave it running. Which one happened is a question about the gesture, so it
   * is answered here rather than inferred upstairs.
   */
  onHubUp: (quick: boolean) => void
  /** The note is latched on. Drawn as a standing ring around the hub. */
  latched?: boolean
  /**
   * 0..1 breath pressure, or null when nothing is listening. Drives the air
   * streaming over the pipe — read every frame, never re-renders.
   */
  airRef?: RefObject<number>
  breathOn?: boolean
  /**
   * Something is covering the disc — a sheet, or the browser being in the
   * background. The air is the most expensive thing on screen and the least
   * necessary one, and drawing weather nobody can see measurably slows down
   * everything that *is* being looked at.
   */
  obscured?: boolean
  /**
   * Stack mode. Semitone offsets from the bottom hole, so 0..12 is a hole as
   * engraved and 13..24 is the same hole an octave up. A tap puts a hole in or
   * takes it out — nothing else. Choosing a note and choosing its octave are
   * two different decisions, and making one tap do both meant that taking a
   * note back out, which is what people do constantly, cost three taps and made
   * you listen to a state you never wanted on the way past.
   *
   * Crucially the disc does *not* turn to a hole you tap here. Every hole is on
   * screen at once, so the rotation buys nothing, and watching the thing swing
   * round under your thumb on every tap made picking four notes feel like a
   * fight. In stack mode the disc holds still and only the light moves.
   */
  stack?: number[]
  stackMode?: boolean
  onToggleStack?: (index: number) => void
}

// ---------------------------------------------------------------------------
// Disc face
// ---------------------------------------------------------------------------

const BRASS = {
  highlight: '#f9e9b6',
  light: '#e3c274',
  mid: '#c69a41',
  deep: '#8f6a24',
  shadow: '#4e3813',
  engrave: '#3d2b0e',
}

function renderDiscFace(size: number, labels: string[]): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const g = c.getContext('2d')!
  const cx = size / 2
  const cy = size / 2
  const R = size / 2 - 2

  g.translate(cx, cy)

  // --- body ---------------------------------------------------------------
  // A conic gradient with several sheen lobes is what makes flat colour read
  // as turned metal. Two lobes look fake; four to six looks machined.
  let body: CanvasGradient
  if (typeof g.createConicGradient === 'function') {
    body = g.createConicGradient(-Math.PI / 4, 0, 0)
    const lobes = 6
    for (let i = 0; i <= lobes * 2; i++) {
      const t = i / (lobes * 2)
      const bright = i % 2 === 0
      body.addColorStop(t, bright ? BRASS.light : BRASS.deep)
    }
  } else {
    body = g.createLinearGradient(-R, -R, R, R)
    body.addColorStop(0, BRASS.deep)
    body.addColorStop(0.5, BRASS.light)
    body.addColorStop(1, BRASS.deep)
  }

  g.beginPath()
  g.arc(0, 0, R, 0, Math.PI * 2)
  g.fillStyle = body
  g.fill()

  // Warm the whole thing toward gold and darken the rim, so it sits in the
  // scene instead of floating on it.
  const warm = g.createRadialGradient(0, -R * 0.25, R * 0.1, 0, 0, R)
  warm.addColorStop(0, 'rgba(255, 232, 170, 0.42)')
  warm.addColorStop(0.55, 'rgba(198, 154, 65, 0.12)')
  warm.addColorStop(1, 'rgba(40, 26, 8, 0.55)')
  g.fillStyle = warm
  g.fill()

  // --- brushed grain ------------------------------------------------------
  // Fine radial scratches. Cheap, and the single biggest contributor to the
  // surface looking touched rather than generated.
  g.save()
  g.globalCompositeOperation = 'overlay'
  for (let i = 0; i < 1400; i++) {
    const a = Math.random() * Math.PI * 2
    const r0 = R * (0.12 + Math.random() * 0.86)
    const len = R * (0.02 + Math.random() * 0.09)
    const alpha = Math.random() * 0.09
    g.strokeStyle =
      Math.random() > 0.5
        ? `rgba(255,240,200,${alpha})`
        : `rgba(60,40,10,${alpha})`
    g.lineWidth = Math.random() * 1.1 + 0.25
    g.beginPath()
    g.arc(0, 0, r0, a, a + len / r0)
    g.stroke()
  }
  g.restore()

  // --- rim ----------------------------------------------------------------
  const ring = (r: number, w: number, stroke: string) => {
    g.beginPath()
    g.arc(0, 0, r, 0, Math.PI * 2)
    g.lineWidth = w
    g.strokeStyle = stroke
    g.stroke()
  }
  ring(R - 1, 2.5, 'rgba(30,20,5,0.75)')
  ring(R - 4, 1.4, 'rgba(255,238,190,0.32)')
  ring(R * 0.9, 1.2, 'rgba(50,34,10,0.45)')
  ring(R * 0.885, 1, 'rgba(255,238,190,0.18)')

  // --- holes --------------------------------------------------------------
  // Thirteen of them, because a real Kratt has thirteen. Nobody will count
  // them; everybody would feel it if they were wrong.
  const holeR = R * 0.545
  for (let i = 0; i < NOTE_COUNT; i++) {
    const a = i * STEP - Math.PI / 2
    const x = Math.cos(a) * holeR
    const y = Math.sin(a) * holeR
    const rr = R * 0.052

    const pit = g.createRadialGradient(x, y - rr * 0.3, rr * 0.1, x, y, rr)
    pit.addColorStop(0, '#0b0803')
    pit.addColorStop(0.7, '#231809')
    pit.addColorStop(1, '#5a4116')
    g.beginPath()
    g.arc(x, y, rr, 0, Math.PI * 2)
    g.fillStyle = pit
    g.fill()
    g.lineWidth = 1
    g.strokeStyle = 'rgba(255,240,195,0.28)'
    g.beginPath()
    g.arc(x, y, rr + 0.6, Math.PI * 0.15, Math.PI * 0.95)
    g.stroke()
  }

  // --- engraved labels ----------------------------------------------------
  const labelR = R * 0.755
  const fontSize = Math.round(R * 0.135)
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.font = `600 ${fontSize}px ui-serif, "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif`

  for (let i = 0; i < NOTE_COUNT; i++) {
    const a = i * STEP - Math.PI / 2
    g.save()
    g.translate(Math.cos(a) * labelR, Math.sin(a) * labelR)
    // Text sits tangential, so whichever note is under the pointer at the top
    // of the disc reads perfectly upright.
    g.rotate(a + Math.PI / 2)

    // Stamped-metal engraving: a light edge below the dark cut.
    g.fillStyle = 'rgba(255,243,205,0.34)'
    g.fillText(labels[i], 0, fontSize * 0.075)
    g.fillStyle = BRASS.engrave
    g.fillText(labels[i], 0, -fontSize * 0.02)
    g.restore()
  }

  // Tick marks between the notes, like a real dial.
  for (let i = 0; i < NOTE_COUNT; i++) {
    const a = (i + 0.5) * STEP - Math.PI / 2
    g.save()
    g.rotate(a)
    g.beginPath()
    g.moveTo(R * 0.895, 0)
    g.lineTo(R * 0.845, 0)
    g.lineWidth = 1.2
    g.strokeStyle = 'rgba(45,30,8,0.4)'
    g.stroke()
    g.restore()
  }

  // --- centre recess ------------------------------------------------------
  const hubR = R * 0.4
  const recess = g.createRadialGradient(0, -hubR * 0.4, hubR * 0.05, 0, 0, hubR)
  recess.addColorStop(0, '#2a1e0c')
  recess.addColorStop(0.75, '#191204')
  recess.addColorStop(1, '#0d0902')
  g.beginPath()
  g.arc(0, 0, hubR, 0, Math.PI * 2)
  g.fillStyle = recess
  g.fill()
  // Bevel: dark at the top, bright at the bottom — reads as a hole, not a lid.
  g.beginPath()
  g.arc(0, 0, hubR, Math.PI * 0.05, Math.PI * 0.95)
  g.lineWidth = 2.2
  g.strokeStyle = 'rgba(255,238,190,0.3)'
  g.stroke()
  g.beginPath()
  g.arc(0, 0, hubR, Math.PI * 1.05, Math.PI * 1.95)
  g.lineWidth = 2.2
  g.strokeStyle = 'rgba(20,12,2,0.75)'
  g.stroke()

  return c
}

// ---------------------------------------------------------------------------
// Air
// ---------------------------------------------------------------------------

interface Mote {
  x: number
  y: number
  vx: number
  vy: number
  /** 1 at birth, 0 at death. */
  life: number
  decay: number
  /** Radius in device pixels at birth. Puffs expand as they age. */
  size: number
  /** Fixed per puff, so each one meanders on its own phase. */
  seed: number
  /** Came out of a hole rather than in from the bottom of the screen. */
  jet: boolean
}

/**
 * One soft puff, drawn once and blitted thereafter.
 *
 * Smoke is not a collection of lines. The first version stroked a short segment
 * per particle, which is cheap and reads as exactly what it is: lint. Volume
 * comes from many soft-edged blobs overlapping, and the only way to afford
 * enough of those is to render the blob once and scale it — building a radial
 * gradient per particle per frame is a different order of cost entirely.
 *
 * The colour is baked in. Density is controlled with globalAlpha, and the
 * additive blend does the rest.
 */
let puffSprite: HTMLCanvasElement | null = null

function puff(): HTMLCanvasElement {
  if (puffSprite) return puffSprite
  const size = 128
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const g = c.getContext('2d')!
  const r = size / 2
  const grad = g.createRadialGradient(r, r, 0, r, r, r)
  // A long, soft shoulder. A tight falloff gives you a ball of light; smoke
  // wants most of its mass out in the tail where the edges can dissolve into
  // each other.
  grad.addColorStop(0, 'rgba(255, 240, 210, 0.55)')
  grad.addColorStop(0.25, 'rgba(255, 234, 196, 0.3)')
  grad.addColorStop(0.55, 'rgba(255, 226, 180, 0.1)')
  grad.addColorStop(0.8, 'rgba(255, 220, 170, 0.028)')
  grad.addColorStop(1, 'rgba(255, 220, 170, 0)')
  g.fillStyle = grad
  g.fillRect(0, 0, size, size)
  puffSprite = c
  return c
}

/**
 * One frame of air.
 *
 * A stream enters from the bottom of the screen — where you are blowing — and
 * rushes up past the pipe. Three things turn a bag of particles into something
 * that reads as fluid, and all three matter:
 *
 *  - **Volume.** Each puff is a soft blob far bigger than the distance between
 *    puffs, so neighbours overlap and the eye sees a continuous body rather
 *    than a scatter of marks.
 *  - **Obstruction.** Near the disc the flow is pushed outward along the
 *    radius, falling off with the square of distance, so it spills round the
 *    rim the way air spills round something solid.
 *  - **Turbulence.** Two sine terms of differing frequency, sampled at the
 *    puff's own position and drifting with time, stand in for a curl-noise
 *    field. Real curl noise would be better and this is close enough that the
 *    stream visibly braids and folds instead of running in parallel lines.
 *
 * `air` is 0..1 breath pressure, and it drives everything an eye reads as
 * force: how much smoke there is, how fast it goes, how far it stretches along
 * its own velocity, and how brightly it shows up.
 */
function blow(
  motes: Mote[],
  air: number,
  halfW: number,
  halfH: number,
  R: number,
  angle: number,
  holes: number[],
  now: number,
  g: CanvasRenderingContext2D,
) {
  // Volume and speed are pulled apart on purpose.
  //
  // How *much* smoke there is answers "can it hear me", and that has to be
  // answerable from the faintest breath — so it rises steeply at the bottom of
  // the range and is nearly saturated by the halfway point. How *fast* it moves
  // answers "how hard am I blowing", and that wants the opposite: a curve that
  // keeps climbing at the top, so there is somewhere left to go once the screen
  // is already full of smoke. One signal, two readings, and between them the
  // whole range says something.
  const volume = Math.pow(air, 0.55)
  const force = 0.22 + 0.78 * Math.pow(air, 1.25)

  const speed = (0.35 + 3.4 * force) * R * 0.011
  const sprite = puff()

  // Scaled by pace as well as by volume. Spawning at a fixed rate per frame
  // means a faster stream is a thinner one — each puff crosses the screen in
  // less time, so fewer are on it — and the picture would quietly lose density
  // exactly as you blew hardest. Population is rate times transit time; if the
  // second term falls, the first has to rise.
  let spawn = (0.22 + 1.9 * volume) * (0.55 + 0.8 * force)
  while (spawn > 0 && motes.length < MAX_MOTES) {
    if (spawn < 1 && Math.random() > spawn) break
    spawn -= 1
    motes.push({
      x: (Math.random() * 2 - 1) * halfW,
      y: halfH * (1 + Math.random() * 0.25),
      vx: (Math.random() * 2 - 1) * speed * 0.2,
      vy: -speed * (0.7 + Math.random() * 0.55),
      life: 1,
      decay: 0.0035 + Math.random() * 0.004,
      // Thinner as it goes faster, which is both what fast gas looks like and
      // what keeps the fill rate flat as the count climbs.
      size: R * (0.1 + Math.random() ** 2 * 0.42) * (1 - 0.2 * force),
      seed: Math.random() * 6.28,
      jet: false,
    })
  }

  // And some of it goes *through* the pipe. Once you are blowing properly, the
  // holes that are actually sounding breathe out small dense puffs that the
  // main stream then carries away — which is the difference between wind over
  // an object and an instrument being played.
  if (volume > 0.3 && holes.length) {
    let jets = (volume - 0.3) * 2.6
    while (jets > 0 && motes.length < MAX_MOTES + 26) {
      if (jets < 1 && Math.random() > jets) break
      jets -= 1
      const a = holes[(Math.random() * holes.length) | 0] * STEP - Math.PI / 2 + angle
      const r = R * 0.545
      motes.push({
        x: Math.cos(a) * r,
        y: Math.sin(a) * r,
        // Spread widely on purpose. A tight jet at full blow stops reading as
        // gas and starts reading as a flame.
        vx: Math.cos(a) * speed * 0.4 + (Math.random() - 0.5) * speed * 0.75,
        vy: Math.sin(a) * speed * 0.4 - speed * (0.3 + Math.random() * 0.35),
        life: 1,
        decay: 0.012 + Math.random() * 0.01,
        size: R * (0.07 + Math.random() * 0.08),
        seed: Math.random() * 6.28,
        jet: true,
      })
    }
  }

  g.save()
  // Additive: smoke crossing smoke brightens instead of muddying, and over the
  // brass it reads as light scattering through haze rather than paint on metal.
  g.globalCompositeOperation = 'lighter'

  const t = now * 0.001

  for (let i = motes.length - 1; i >= 0; i--) {
    const m = motes[i]

    const d = Math.hypot(m.x, m.y) || 1
    const push = Math.min(speed * 0.5, ((R * 0.62) / d) ** 2 * speed * 0.06)
    m.vx += (m.x / d) * push
    m.vy += (m.y / d) * push

    // The stand-in for curl noise. Sampled in the puff's own frame so the field
    // is coherent — neighbours get near-identical nudges and travel together,
    // which is what makes a body of smoke fold rather than fray.
    const swirl =
      Math.sin(m.y * 0.011 + t * 1.3 + m.seed) +
      0.55 * Math.sin(m.x * 0.008 - t * 0.9 + m.seed * 1.7)
    m.vx += swirl * speed * 0.08
    m.vy += 0.4 * Math.cos(m.x * 0.009 + t * 1.1 + m.seed) * speed * 0.03

    m.vx *= 0.985
    m.vy *= 0.985
    m.x += m.vx
    m.y += m.vy
    m.life -= m.decay

    if (m.life <= 0 || m.y < -halfH * 1.2) {
      motes.splice(i, 1)
      continue
    }

    // Smoke expands as it goes. Growing rather than merely fading is most of
    // why a puff looks like a volume of gas and not a dot with an opacity.
    const age = 1 - m.life
    const size = m.size * (1 + age * (m.jet ? 2.6 : 1.1))

    // In from nothing, out to nothing. A puff that appears at full strength is
    // a puff you can count.
    const env = Math.min(1, age * 6) * Math.min(1, m.life * 2.6)
    // Faded to nothing at every side of this surface, not just the two the
    // flow happens to cross. Smoke that stops along a straight line is a
    // rectangle you didn't know was there — the same fault the glow had, and
    // more obvious here because there is more of it.
    // Nothing here about the edges of the surface: the layer is masked in CSS,
    // which fades the composited result instead of each puff by where its
    // centre happens to be.
    const alpha = (0.05 + 0.3 * volume) * env * (m.jet ? 1.15 : 1)
    if (alpha <= 0.003) continue

    // Stretched along its own velocity, and hard. Fast gas smears into
    // filaments; without this the stream is a procession of round blobs, which
    // is a lava lamp and not a wind.
    const v = Math.hypot(m.vx, m.vy)
    const stretch = 1 + Math.min(3.4, v / (R * 0.014))

    g.save()
    g.translate(m.x, m.y)
    g.rotate(Math.atan2(m.vy, m.vx))
    g.globalAlpha = Math.min(0.85, alpha)
    g.drawImage(sprite, -size * stretch, -size, size * 2 * stretch, size * 2)
    g.restore()
  }

  g.restore()
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PitchDisc({
  noteIndex,
  onNoteIndexChange,
  labels,
  centerLabel,
  centerSub,
  glowRef,
  hubActive,
  onHubDown,
  onHubUp,
  latched,
  airRef,
  breathOn,
  obscured,
  stack,
  stackMode,
  onToggleStack,
}: PitchDiscProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  /**
   * The amber pool the disc sits in.
   *
   * A DOM layer rather than a gradient painted into the canvas: the canvas has
   * edges, and a halo that reaches them stops dead at a rectangle nobody knew
   * was there. Out here it can spill as far past the instrument as it likes and
   * fade to nothing on its own terms.
   */
  const glowElRef = useRef<HTMLDivElement>(null)
  /**
   * The air gets a surface of its own, larger than the disc's.
   *
   * Painting it into the disc canvas confined a stream that is supposed to
   * blow across the screen to a square barely wider than the instrument, and
   * fog reaching the edge of that square drew exactly the hard rectangle the
   * glow used to. Out here it has room to arrive and leave. Backed at a lower
   * pixel ratio than the disc on purpose: every mark on it is a soft gradient
   * with no edge to resolve, and the fill rate is better spent on area.
   */
  const airRef2 = useRef<HTMLCanvasElement>(null)
  const airSizeRef = useRef({ w: 0, h: 0 })

  const faceRef = useRef<HTMLCanvasElement | null>(null)
  const sizeRef = useRef(0)
  const dprRef = useRef(1)
  /** Disc diameter in device pixels. */
  const discPxRef = useRef(0)

  const angleRef = useRef(0)
  const velRef = useRef(0)
  const draggingRef = useRef(false)
  const snappingRef = useRef(true)
  const lastIndexRef = useRef(noteIndex)
  /** Non-null while easing to a specific detent (tap, or an external change). */
  const targetRef = useRef<number | null>(null)

  const pointerRef = useRef({ id: -1, angle: 0, moved: 0, t: 0, onHub: false })
  const hubActiveRef = useRef(hubActive)
  const centerRef = useRef({ label: centerLabel, sub: centerSub })
  const ringsRef = useRef<{ t: number }[]>([])

  const stackRef = useRef<number[]>(stack ?? [])
  const stackModeRef = useRef(false)
  const toggleRef = useRef(onToggleStack)
  /**
   * Taps waiting to be drawn as a ripple at the hole they landed on.
   *
   * The disc no longer turns to a tapped hole, so the confirmation that used to
   * come from the movement has to come from somewhere — and it should come from
   * the place your thumb actually touched.
   */
  const pulsesRef = useRef<{ index: number; t: number }[]>([])

  const latchedRef = useRef(false)
  latchedRef.current = latched ?? false
  const breathOnRef = useRef(false)
  breathOnRef.current = breathOn ?? false

  /**
   * Air over the pipe.
   *
   * Blowing at a phone gives you no feedback at all — you cannot hear yourself
   * over the speaker and there is nothing on screen that moves with the breath.
   * These streaks are that missing half: they rush faster, brighter and thicker
   * the harder you blow, and they idle to a drift when the microphone is open
   * but nothing is happening, which doubles as "it is listening".
   */
  const motesRef = useRef<Mote[]>([])
  const stillRef = useRef(false)
  stillRef.current = wantsStillness()
  const obscuredRef = useRef(false)
  obscuredRef.current = obscured ?? false
  /** Smoothed pressure. Rises fast, falls slowly, so a puff leaves a wake. */
  const airShownRef = useRef(0)

  hubActiveRef.current = hubActive
  centerRef.current = { label: centerLabel, sub: centerSub }
  stackRef.current = stack ?? []
  stackModeRef.current = stackMode ?? false
  toggleRef.current = onToggleStack

  // Label i is engraved at disc-local angle `i * STEP - π/2`, so after the disc
  // is rotated by `angle` it appears on screen at `i * STEP - π/2 + angle`.
  // Setting that equal to the pointer position (screen top, -π/2) gives
  // `angle = -i * STEP`, which is the whole of the maths below.
  const indexFromAngle = (angle: number) => {
    const k = Math.round(angle / STEP)
    return ((-k % NOTE_COUNT) + NOTE_COUNT) % NOTE_COUNT
  }
  const angleForIndex = (index: number, near: number) => {
    // Pick the rotation of this detent nearest the current angle, so the disc
    // never takes the long way round.
    const base = -index * STEP
    const turns = Math.round((near - base) / (Math.PI * 2))
    return base + turns * Math.PI * 2
  }

  // --- sizing -------------------------------------------------------------
  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return

    const resize = () => {
      const rect = wrap.getBoundingClientRect()
      const size = Math.floor(Math.min(rect.width, rect.height))
      if (size <= 0) return
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5)
      if (size === sizeRef.current && dpr === dprRef.current) return
      sizeRef.current = size
      dprRef.current = dpr
      canvas.width = size * dpr
      canvas.height = size * dpr
      canvas.style.width = `${size}px`
      canvas.style.height = `${size}px`
      discPxRef.current = Math.floor(size * dpr * DISC_FILL)
      faceRef.current = renderDiscFace(discPxRef.current, labels)

      const air = airRef2.current
      if (air) {
        const ar = air.getBoundingClientRect()
        const w = Math.max(1, Math.floor(ar.width * AIR_DPR))
        const h = Math.max(1, Math.floor(ar.height * AIR_DPR))
        if (air.width !== w || air.height !== h) {
          air.width = w
          air.height = h
        }
        // In disc pixels, so the flow can be written against the disc's own
        // radius without a second set of units to keep straight.
        airSizeRef.current = { w: (w / AIR_DPR) * dpr, h: (h / AIR_DPR) * dpr }
      }
    }

    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [labels])

  // Re-engrave when the user flips between sharps and flats.
  useEffect(() => {
    if (discPxRef.current > 0) {
      faceRef.current = renderDiscFace(discPxRef.current, labels)
    }
  }, [labels])

  // --- external selection changes ----------------------------------------
  const mountedRef = useRef(false)
  useEffect(() => {
    const firstPass = !mountedRef.current
    mountedRef.current = true
    if (draggingRef.current) return
    if (indexFromAngle(angleRef.current) === noteIndex) return
    snappingRef.current = true
    velRef.current = 0

    // On the first pass we're restoring the note from last rehearsal, so the
    // disc should already be there — no spin, no clicks, and above all no
    // buzzing the phone before anyone has touched it.
    if (firstPass) {
      angleRef.current = angleForIndex(noteIndex, 0)
      lastIndexRef.current = noteIndex
      return
    }
    // Otherwise ease across; assigning directly would teleport.
    targetRef.current = angleForIndex(noteIndex, angleRef.current)
  }, [noteIndex])

  // --- draw loop ----------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const g = canvas.getContext('2d')!
    let raf = 0
    let alive = true

    const frame = () => {
      if (!alive) return
      raf = requestAnimationFrame(frame)

      const size = sizeRef.current
      const face = faceRef.current
      if (!size || !face) return
      const dpr = dprRef.current

      // --- physics -------------------------------------------------------
      let landed = false
      if (!draggingRef.current) {
        if (targetRef.current !== null) {
          const d = targetRef.current - angleRef.current
          angleRef.current += d * 0.2
          if (Math.abs(d) < 0.0008) {
            angleRef.current = targetRef.current
            targetRef.current = null
            landed = true
          }
        } else {
          angleRef.current += velRef.current
          velRef.current *= FRICTION
          if (Math.abs(velRef.current) < SNAP_VELOCITY) {
            velRef.current = 0
            snappingRef.current = true
          }
          if (snappingRef.current) {
            const k = Math.round(angleRef.current / STEP)
            angleRef.current += (k * STEP - angleRef.current) * 0.22
          }
        }
      }

      // --- detents -------------------------------------------------------
      // Every note the disc passes clicks and buzzes, but only the note it
      // comes to rest on is reported. Announcing the ones it flies past would
      // fight whatever asked it to move here in the first place.
      const idx = indexFromAngle(angleRef.current)
      if (idx !== lastIndexRef.current) {
        const speed = Math.abs(velRef.current)
        lastIndexRef.current = idx
        playDetentClick(draggingRef.current ? 1 : Math.min(1, speed * 40 + 0.3))
        if (navigator.vibrate) navigator.vibrate(7)
        if (targetRef.current === null && !landed) onNoteIndexChange(idx)
      }
      if (landed) onNoteIndexChange(idx)

      // --- paint ---------------------------------------------------------
      const glow = Math.max(0, Math.min(1, glowRef.current ?? 0))
      const px = size * dpr
      const R = discPxRef.current / 2

      g.setTransform(1, 0, 0, 1, 0, 0)
      g.clearRect(0, 0, px, px)
      g.translate(px / 2, px / 2)

      // Drop shadow: the disc sits on the felt rather than floating over it.
      const shadow = g.createRadialGradient(
        0,
        R * 0.06,
        R * 0.8,
        0,
        R * 0.08,
        R * 1.14,
      )
      shadow.addColorStop(0, 'rgba(0,0,0,0.55)')
      shadow.addColorStop(1, 'rgba(0,0,0,0)')
      g.fillStyle = shadow
      g.fillRect(-px / 2, -px / 2, px, px)

      // The amber pool is a DOM layer behind the canvas — see glowElRef. All we
      // do here is tell it how bright to be.
      if (glowElRef.current) glowElRef.current.style.opacity = glow.toFixed(3)

      g.save()
      g.rotate(angleRef.current)
      g.drawImage(face, -R, -R)

      // --- stacked holes ---------------------------------------------------
      // Drawn inside the rotation so the marks stay welded to their holes, and
      // over the pre-rendered face rather than into it, because the set changes
      // on every tap and re-engraving the whole disc for that would be absurd.
      const marks = stackRef.current
      if (stackModeRef.current || marks.length) {
        const holeR = R * 0.545
        const rr = R * 0.052
        const now = performance.now()
        pulsesRef.current = pulsesRef.current.filter((p) => now - p.t < PULSE_MS)

        for (let i = 0; i < NOTE_COUNT; i++) {
          const inStack = marks.includes(i)
          const raised = marks.includes(i + 12)
          const a = i * STEP - Math.PI / 2
          const x = Math.cos(a) * holeR
          const y = Math.sin(a) * holeR

          // Every hole is a target while a stack is being built, and the only
          // way to know that without being told is for every hole to say so.
          if (stackModeRef.current && !inStack && !raised) {
            g.beginPath()
            g.arc(x, y, rr + 2.6 * dpr, 0, Math.PI * 2)
            g.lineWidth = 1.2 * dpr
            g.setLineDash([2.4 * dpr, 3.6 * dpr])
            g.strokeStyle = 'rgba(255, 228, 170, 0.32)'
            g.stroke()
            g.setLineDash([])
          }
          if (!inStack && !raised) continue

          // The hole reads as *open* — lit from within, the way a hole you're
          // blowing through would be.
          const lit = g.createRadialGradient(x, y, 0, x, y, rr * 2.6)
          lit.addColorStop(0, `rgba(255, 200, 110, ${0.75 - 0.25 * (1 - glow)})`)
          lit.addColorStop(0.42, 'rgba(255, 178, 60, 0.35)')
          lit.addColorStop(1, 'rgba(255, 160, 40, 0)')
          g.beginPath()
          g.arc(x, y, rr * 2.6, 0, Math.PI * 2)
          g.fillStyle = lit
          g.fill()

          g.beginPath()
          g.arc(x, y, rr + 2.5 * dpr, 0, Math.PI * 2)
          g.lineWidth = 1.8 * dpr
          g.strokeStyle = 'rgba(255, 214, 140, 0.9)'
          g.stroke()

          // Octave up gets a second ring rather than an arrow. An arrow has to
          // be rotated to sit square on its hole, which at the bottom of the
          // disc leaves it pointing sideways and reading as a stray chevron —
          // and pushed far enough out to clear the glow it lands on the
          // engraved letter. A ring around a ring has no orientation to get
          // wrong, and it says the same thing: this one is doubled.
          if (raised) {
            g.beginPath()
            g.arc(x, y, rr + 6 * dpr, 0, Math.PI * 2)
            g.lineWidth = 1.4 * dpr
            g.strokeStyle = 'rgba(255, 214, 140, 0.75)'
            g.stroke()
          }
        }

        // The ripple that used to be a swing of the whole disc.
        for (const pulse of pulsesRef.current) {
          const k = (now - pulse.t) / PULSE_MS
          const a = pulse.index * STEP - Math.PI / 2
          g.beginPath()
          g.arc(
            Math.cos(a) * holeR,
            Math.sin(a) * holeR,
            rr * (1 + k * 3.6),
            0,
            Math.PI * 2,
          )
          g.lineWidth = 2.6 * dpr * (1 - k)
          g.strokeStyle = `rgba(255, 216, 145, ${0.7 * (1 - k)})`
          g.stroke()
        }
      }
      g.restore()

      // --- air ---------------------------------------------------------------
      const airCanvas = airRef2.current
      const ag = airCanvas?.getContext('2d')
      if (airCanvas && ag) {
        ag.setTransform(1, 0, 0, 1, 0, 0)
        ag.clearRect(0, 0, airCanvas.width, airCanvas.height)
        const hidden =
          obscuredRef.current || (typeof document !== 'undefined' && document.hidden)
        if (breathOnRef.current && !stillRef.current && !hidden) {
          const want = Math.max(0, Math.min(1, airRef?.current ?? 0))
          const a = airShownRef.current
          // Rises with the breath and falls well behind it, so a puff leaves a
          // wake instead of snapping off the moment the gate shuts.
          airShownRef.current = a + (want - a) * (want > a ? 0.4 : 0.05)
          // The holes that are actually sounding: the whole stack, or the one
          // note under the pointer. Rotated with the disc, since they are
          // welded to it and the air is not.
          const lit = stackModeRef.current
            ? [...new Set(stackRef.current.map(stackHole))]
            : [lastIndexRef.current]
          const { w, h } = airSizeRef.current
          // Scaled so the flow can be written in the disc's pixels while the
          // surface underneath is backed more coarsely.
          const k = airCanvas.width / (w || 1)
          ag.setTransform(k, 0, 0, k, airCanvas.width / 2, airCanvas.height / 2)
          blow(
            motesRef.current,
            airShownRef.current,
            w / 2,
            h / 2,
            R,
            angleRef.current,
            lit,
            performance.now(),
            ag,
          )
        } else if (motesRef.current.length) {
          motesRef.current.length = 0
          airShownRef.current = 0
        }
      }

      // --- pointer ----------------------------------------------------------
      // Fixed at twelve o'clock while the disc turns underneath it. This is
      // the thing that makes the object legible: the note it's biting into is
      // the note you get.
      {
        const tip = -R * 0.995
        const back = -R * 1.115
        const halfW = R * 0.052
        g.beginPath()
        g.moveTo(0, tip)
        g.lineTo(-halfW, back)
        g.lineTo(halfW, back)
        g.closePath()
        const pg = g.createLinearGradient(0, back, 0, tip)
        pg.addColorStop(0, '#8a6f38')
        pg.addColorStop(0.45, '#f4dfa4')
        pg.addColorStop(1, glow > 0.02 ? '#ffc86a' : '#c9a758')
        g.fillStyle = pg
        g.shadowColor = `rgba(255, 170, 60, ${0.8 * glow})`
        g.shadowBlur = 18 * dpr * glow
        g.fill()
        g.shadowBlur = 0
        g.lineWidth = 1 * dpr
        g.strokeStyle = 'rgba(20, 13, 3, 0.6)'
        g.stroke()
      }

      // --- expanding rings ------------------------------------------------
      if (glow > 0.28) {
        const last = ringsRef.current[ringsRef.current.length - 1]
        if (!last || performance.now() - last.t > 620) {
          ringsRef.current.push({ t: performance.now() })
        }
      }
      ringsRef.current = ringsRef.current.filter(
        (r) => performance.now() - r.t < 1500,
      )
      for (const r of ringsRef.current) {
        const p = (performance.now() - r.t) / 1500
        const rr = R * (0.42 + p * 0.62)
        g.beginPath()
        g.arc(0, 0, rr, 0, Math.PI * 2)
        g.lineWidth = 2 * dpr * (1 - p)
        g.strokeStyle = `rgba(255, 196, 92, ${0.3 * (1 - p) * glow})`
        g.stroke()
      }

      // --- hub -------------------------------------------------------------
      const hubR = R * 0.4
      if (glow > 0.001) {
        const inner = g.createRadialGradient(0, 0, 0, 0, 0, hubR)
        inner.addColorStop(0, `rgba(255, 205, 120, ${0.55 * glow})`)
        inner.addColorStop(0.6, `rgba(255, 160, 55, ${0.22 * glow})`)
        inner.addColorStop(1, 'rgba(255, 150, 40, 0)')
        g.beginPath()
        g.arc(0, 0, hubR, 0, Math.PI * 2)
        g.fillStyle = inner
        g.fill()
      }
      if (hubActiveRef.current) {
        g.beginPath()
        g.arc(0, 0, hubR - 2 * dpr, 0, Math.PI * 2)
        g.lineWidth = 1.6 * dpr
        g.strokeStyle = 'rgba(255, 205, 130, 0.5)'
        g.stroke()
      }
      // A latched note has nothing holding it down, so it says so: a standing
      // ring that breathes, which is the difference between "this is on" and
      // "you are pressing this".
      if (latchedRef.current) {
        const beat = 0.55 + 0.25 * Math.sin(performance.now() / 620)
        g.beginPath()
        g.arc(0, 0, hubR - 4 * dpr, 0, Math.PI * 2)
        g.lineWidth = 2.2 * dpr
        g.strokeStyle = `rgba(255, 196, 110, ${beat})`
        g.stroke()
      }

      // The current note, fixed and upright in the middle — the thing you read
      // at a glance in a dark hall without stopping the beat.
      const { label, sub } = centerRef.current
      const noteSize = hubR * 0.72
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.font = `500 ${noteSize}px ui-serif, "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif`
      g.shadowColor = `rgba(255, 170, 60, ${0.55 + 0.45 * glow})`
      g.shadowBlur = (8 + 26 * glow) * dpr
      g.fillStyle = `rgb(255, ${228 + Math.round(20 * glow)}, ${190 + Math.round(50 * glow)})`
      g.fillText(label, 0, -hubR * 0.06)
      g.shadowBlur = 0

      // Chord names vary wildly in length ("Major" vs "Barbershop 7th"), so the
      // caption is measured and shrunk to fit rather than trusted to fit.
      const subText = sub.toUpperCase()
      const subFamily = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
      let subSize = hubR * 0.145
      let subTrack = hubR * 0.035
      g.letterSpacing = `${subTrack}px`
      g.font = `500 ${subSize}px ${subFamily}`
      const maxSubW = hubR * 1.46
      const measured = g.measureText(subText).width
      if (measured > maxSubW) {
        const k = maxSubW / measured
        subSize *= k
        subTrack *= k
        g.letterSpacing = `${subTrack}px`
        g.font = `500 ${subSize}px ${subFamily}`
      }
      g.fillStyle = 'rgba(255, 214, 150, 0.5)'
      g.fillText(subText, 0, hubR * 0.5)
      g.letterSpacing = '0px'
    }

    raf = requestAnimationFrame(frame)
    return () => {
      alive = false
      cancelAnimationFrame(raf)
    }
  }, [glowRef, onNoteIndexChange])

  // --- pointer ------------------------------------------------------------
  const localAngle = useCallback((e: PointerEvent | React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - (rect.left + rect.width / 2)
    const y = e.clientY - (rect.top + rect.height / 2)
    return { angle: Math.atan2(y, x), radius: Math.hypot(x, y) / (rect.width / 2) }
  }, [])

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const { angle, radius } = localAngle(e)
      // `radius` is normalised to the canvas, and the disc only fills part of
      // it, so both bounds are scaled to the disc rather than the box.
      if (radius > DISC_FILL * 1.04) return
      canvasRef.current?.setPointerCapture(e.pointerId)
      const onHub = radius < DISC_FILL * 0.4
      pointerRef.current = {
        id: e.pointerId,
        angle,
        moved: 0,
        t: performance.now(),
        onHub,
      }
      if (onHub) {
        onHubDown()
        return
      }
      draggingRef.current = true
      snappingRef.current = false
      targetRef.current = null
      velRef.current = 0
    },
    [localAngle, onHubDown],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const p = pointerRef.current
      if (p.id !== e.pointerId) return
      const { angle } = localAngle(e)
      let d = angle - p.angle
      // Shortest way round, so crossing the ±π seam doesn't fling the disc.
      while (d > Math.PI) d -= Math.PI * 2
      while (d < -Math.PI) d += Math.PI * 2
      p.angle = angle
      p.moved += Math.abs(d)
      if (p.onHub) return

      angleRef.current += d
      // Blend into the velocity estimate rather than replacing it, or a single
      // jittery sample at release throws the disc across the room.
      velRef.current = velRef.current * 0.6 + d * 0.4
    },
    [localAngle],
  )

  const endPointer = useCallback(
    (e: React.PointerEvent, cancelled = false) => {
      const p = pointerRef.current
      if (p.id !== e.pointerId) return
      pointerRef.current = { ...p, id: -1 }

      if (p.onHub) {
        // A cancelled gesture is one the browser took away — a notification
        // pulling focus, a palm on the screen. Latching a note off the back of
        // that would be a note nobody asked for.
        onHubUp(!cancelled && performance.now() - p.t < TAP_MS && p.moved < 0.15)
        return
      }

      draggingRef.current = false
      snappingRef.current = true

      // A tap on the ring, rather than a drag, jumps straight to that note.
      const isTap = p.moved < 0.05 && performance.now() - p.t < 350
      if (isTap) {
        // Invert the engraving formula: which label is sitting where you hit?
        const { angle } = localAngle(e)
        const k = Math.round((angle + Math.PI / 2 - angleRef.current) / STEP)
        const tapped = ((k % NOTE_COUNT) + NOTE_COUNT) % NOTE_COUNT
        velRef.current = 0
        if (stackModeRef.current) {
          // Building a stack is a series of taps, and turning the whole disc
          // under the thumb between each one is disorienting for no gain: every
          // hole is already reachable. Light the hole, ripple where the finger
          // landed, buzz, and leave the disc exactly where it was.
          toggleRef.current?.(tapped)
          pulsesRef.current.push({ index: tapped, t: performance.now() })
          if (navigator.vibrate) navigator.vibrate(12)
        } else {
          targetRef.current = angleForIndex(tapped, angleRef.current)
        }
      }
    },
    [localAngle, onHubUp],
  )

  return (
    <div className="disc-wrap" ref={wrapRef}>
      <div className="disc-glow" ref={glowElRef} aria-hidden="true" />
      <canvas className="air-canvas" ref={airRef2} aria-hidden="true" />
      <canvas
        ref={canvasRef}
        className="disc-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => endPointer(e)}
        onPointerCancel={(e) => endPointer(e, true)}
        role="slider"
        tabIndex={0}
        aria-label={
          stackMode
            ? 'Pitch pipe in stack mode. Tap a hole to add or remove that note.'
            : 'Pitch pipe. Left and right arrows change note, space sounds it.'
        }
        aria-valuemin={0}
        aria-valuemax={NOTE_COUNT - 1}
        aria-valuenow={noteIndex}
        aria-valuetext={centerLabel}
      />
    </div>
  )
}
