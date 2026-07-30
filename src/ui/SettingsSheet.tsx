import { useEffect, useRef } from 'react'

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
