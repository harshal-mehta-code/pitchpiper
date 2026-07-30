import { useEffect, useRef } from 'react'
import type { BreathFrame, BreathStatus } from '../audio/breath'

/**
 * A live picture of what the microphone is hearing.
 *
 * Breath detection is the one part of this app that depends on the physical
 * world cooperating, so it should never be a black box. Showing the level, the
 * trigger line and whether the signal looks like *breath* rather than *sound*
 * turns "why isn't it working" into "ah, I need to blow closer".
 */

const STATUS_TEXT: Record<BreathStatus, string> = {
  idle: 'Breath off',
  requesting: 'Asking for the microphone…',
  calibrating: 'Listening to the room — hold still',
  listening: 'Blow at the bottom of your phone',
  denied: 'Microphone blocked. Allow it in your browser settings.',
  unsupported: 'This browser can’t reach the microphone.',
  error: 'Microphone unavailable.',
}

export interface BreathMeterProps {
  status: BreathStatus
  /** What the browser actually said, when it said anything useful. */
  detail?: string
  /** Written every animation frame by the detector, never through React. */
  frameRef: React.RefObject<BreathFrame | null>
}

export function BreathMeter({ status, detail, frameRef }: BreathMeterProps) {
  const fillRef = useRef<HTMLDivElement>(null)
  const markRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let raf = 0
    const frame = () => {
      raf = requestAnimationFrame(frame)
      const f = frameRef.current
      const fill = fillRef.current
      const mark = markRef.current
      const bar = barRef.current
      if (!f || !fill || !mark || !bar) return

      // The bar tops out at three times the trigger level: enough headroom to
      // see that you're well past it, without the useful range squashed flat.
      const span = Math.max(1e-6, f.threshold * 3)
      const raw = Math.min(1, f.energy / span)
      fill.style.transform = `scaleX(${raw.toFixed(4)})`
      // Amber once we believe it's breath, cool grey when it's just sound.
      fill.style.background = f.blowing
        ? 'linear-gradient(90deg, #ffb23c, #ffd689)'
        : 'rgba(150, 170, 160, 0.35)'
      mark.style.left = `${Math.min(98, (f.threshold / span) * 100)}%`
      bar.style.opacity = f.blowing ? '1' : '0.72'
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [frameRef])

  const bad = status === 'denied' || status === 'unsupported' || status === 'error'

  return (
    <div className={`breath-meter${bad ? ' is-bad' : ''}`}>
      <div className="breath-bar" ref={barRef}>
        <div className="breath-fill" ref={fillRef} />
        <div className="breath-mark" ref={markRef} />
      </div>
      <div className="breath-status">{STATUS_TEXT[status]}</div>
      {bad && detail && <div className="breath-detail">{detail}</div>}
      {status === 'denied' && (
        <div className="breath-detail">
          On iPhone: <strong>aA</strong> in the address bar → Website Settings →
          Microphone → Allow.
        </div>
      )}
    </div>
  )
}
