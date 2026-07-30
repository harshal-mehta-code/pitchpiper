import { useEffect, useRef } from 'react'
import type { BreathFrame } from '../audio/breath'

export interface SettingsSheetProps {
  open: boolean
  onClose: () => void
  a4: number
  onA4: (v: number) => void
  useFlats: boolean
  onUseFlats: (v: boolean) => void
  keepAwake: boolean
  onKeepAwake: (v: boolean) => void
  sensitivity: number
  onSensitivity: (v: number) => void
  breathMode: boolean
  onRecalibrate: () => void
  volume: number
  onVolume: (v: number) => void
  breathFrameRef: React.RefObject<BreathFrame | null>
}

export function SettingsSheet(props: SettingsSheetProps) {
  const { open, onClose } = props
  const sheetRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="sheet-scrim" onPointerDown={onClose}>
      <div
        className="sheet"
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="sheet-grip" />

        <Row label="Concert pitch" value={`A = ${props.a4} Hz`}>
          <input
            type="range"
            min={430}
            max={446}
            step={1}
            value={props.a4}
            onChange={(e) => props.onA4(Number(e.target.value))}
          />
          <p className="hint">
            Plenty of choruses tune to 442. Match whatever the piano is doing.
          </p>
        </Row>

        <Row label="Volume" value={`${Math.round(props.volume * 100)}%`}>
          <input
            type="range"
            min={0.1}
            max={1}
            step={0.05}
            value={props.volume}
            onChange={(e) => props.onVolume(Number(e.target.value))}
          />
        </Row>

        <Row label="Note names" value={props.useFlats ? 'Flats' : 'Sharps'}>
          <div className="switch-row">
            <button
              className={`chip${!props.useFlats ? ' is-on' : ''}`}
              onClick={() => props.onUseFlats(false)}
            >
              F♯ G♯ A♯
            </button>
            <button
              className={`chip${props.useFlats ? ' is-on' : ''}`}
              onClick={() => props.onUseFlats(true)}
            >
              G♭ A♭ B♭
            </button>
          </div>
        </Row>

        <Row
          label="Breath sensitivity"
          value={props.breathMode ? undefined : 'Breath mode is off'}
        >
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={props.sensitivity}
            disabled={!props.breathMode}
            onChange={(e) => props.onSensitivity(Number(e.target.value))}
          />
          <div className="range-ends">
            <span>Needs a real puff</span>
            <span>Hair trigger</span>
          </div>
          <button
            className="chip wide"
            onClick={props.onRecalibrate}
            disabled={!props.breathMode}
          >
            Re-listen to the room
          </button>
          <p className="hint">
            Do this when you move somewhere noisier. Stay quiet for a second
            while it measures.
          </p>
          {props.breathMode && <MicDiagnostics frameRef={props.breathFrameRef} />}
        </Row>

        <Row label="Keep screen awake" value={props.keepAwake ? 'On' : 'Off'}>
          <div className="switch-row">
            <button
              className={`chip${props.keepAwake ? ' is-on' : ''}`}
              onClick={() => props.onKeepAwake(true)}
            >
              On
            </button>
            <button
              className={`chip${!props.keepAwake ? ' is-on' : ''}`}
              onClick={() => props.onKeepAwake(false)}
            >
              Off
            </button>
          </div>
        </Row>

        <div className="sheet-about">
          <strong>Pitch Piper</strong> — thirteen holes, F to F, same as the
          Kratt in your jacket pocket. Add it to your home screen and it works
          with no signal at all.
        </div>

        <button className="sheet-close" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  )
}

/**
 * What the microphone is actually reporting.
 *
 * Breath detection depends on hardware that varies wildly between phones, and
 * "it doesn't trigger" is impossible to diagnose from a description. This shows
 * both gate conditions separately, so a failure points straight at its cause:
 * level below the trigger line, or a spectrum that doesn't look like breath.
 */
function MicDiagnostics({
  frameRef,
}: {
  frameRef: React.RefObject<BreathFrame | null>
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const f = frameRef.current
      const el = ref.current
      if (!f || !el) return
      const ratio = f.threshold > 0 ? f.energy / f.threshold : 0
      el.textContent =
        `level ${ratio.toFixed(2)}× trigger · ` +
        `breath-like ${f.noisiness.toFixed(2)} · ` +
        (f.blowing ? 'BLOWING' : 'closed')
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [frameRef])

  return (
    <div className="diagnostics">
      <div className="diagnostics-label">Microphone right now</div>
      <div className="diagnostics-values" ref={ref}>
        waiting…
      </div>
      <p className="hint">
        Blow at the phone and watch this. Level needs to pass 1.00×; if it does
        and nothing sounds, send me both numbers.
      </p>
    </div>
  )
}

function Row({
  label,
  value,
  children,
}: {
  label: string
  value?: string
  children: React.ReactNode
}) {
  return (
    <div className="sheet-row">
      <div className="sheet-row-head">
        <span className="sheet-row-label">{label}</span>
        {value && <span className="sheet-row-value">{value}</span>}
      </div>
      {children}
    </div>
  )
}
