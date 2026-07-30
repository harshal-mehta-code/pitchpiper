import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { playDetentClick } from '../audio/engine'

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
  onHubUp: () => void
  /**
   * Stack mode. Semitone offsets from the bottom hole, so 0..12 is a hole as
   * engraved and 13..24 is the same hole an octave up. Tapping the ring cycles
   * a hole through off → in → an octave up → off, which is the whole of the
   * interface for building a custom voicing: no extra panel, no note list, just
   * the instrument with more of it lit.
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
  stack,
  stackMode,
  onToggleStack,
}: PitchDiscProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

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

      // Amber pool underneath the metal, so the disc looks lit rather than
      // painted when it sounds.
      if (glow > 0.001) {
        const halo = g.createRadialGradient(0, 0, R * 0.2, 0, 0, R * 1.42)
        halo.addColorStop(0, `rgba(255, 178, 60, ${0.4 * glow})`)
        halo.addColorStop(0.5, `rgba(255, 150, 40, ${0.15 * glow})`)
        halo.addColorStop(1, 'rgba(255, 140, 30, 0)')
        g.fillStyle = halo
        g.fillRect(-px / 2, -px / 2, px, px)
      }

      g.save()
      g.rotate(angleRef.current)
      g.drawImage(face, -R, -R)

      // --- stacked holes ---------------------------------------------------
      // Drawn inside the rotation so the marks stay welded to their holes, and
      // over the pre-rendered face rather than into it, because the set changes
      // on every tap and re-engraving the whole disc for that would be absurd.
      const marks = stackRef.current
      if (marks.length) {
        const holeR = R * 0.545
        const rr = R * 0.052
        for (let i = 0; i < NOTE_COUNT; i++) {
          const inStack = marks.includes(i)
          const raised = marks.includes(i + 12)
          if (!inStack && !raised) continue
          const a = i * STEP - Math.PI / 2
          const x = Math.cos(a) * holeR
          const y = Math.sin(a) * holeR

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

          // A caret pointing outward for the octave-up copy of a hole.
          if (raised) {
            const tipR = holeR + rr * 2.9
            g.save()
            g.translate(Math.cos(a) * tipR, Math.sin(a) * tipR)
            g.rotate(a + Math.PI / 2)
            const w = rr * 0.75
            g.beginPath()
            g.moveTo(-w, w * 0.6)
            g.lineTo(0, -w * 0.5)
            g.lineTo(w, w * 0.6)
            g.lineWidth = 1.8 * dpr
            g.lineCap = 'round'
            g.lineJoin = 'round'
            g.strokeStyle = 'rgba(255, 214, 140, 0.95)'
            g.stroke()
            g.restore()
          }
        }
      }
      g.restore()

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
    (e: React.PointerEvent) => {
      const p = pointerRef.current
      if (p.id !== e.pointerId) return
      pointerRef.current = { ...p, id: -1 }

      if (p.onHub) {
        onHubUp()
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
        targetRef.current = angleForIndex(tapped, angleRef.current)
        // In stack mode the tap also changes what that hole is doing. The disc
        // still spins to it, so you can see which one you hit.
        if (stackModeRef.current) toggleRef.current?.(tapped)
      }
    },
    [localAngle, onHubUp],
  )

  return (
    <div className="disc-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="disc-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        role="slider"
        tabIndex={0}
        aria-label="Pitch pipe. Left and right arrows change note, space sounds it."
        aria-valuemin={0}
        aria-valuemax={NOTE_COUNT - 1}
        aria-valuenow={noteIndex}
        aria-valuetext={centerLabel}
      />
    </div>
  )
}
