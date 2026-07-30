import { CHORD_TYPES } from '../music/notes'

export interface ControlTrayProps {
  chordId: string
  onChordId: (id: string) => void
  octaveShift: number
  onOctaveShift: (v: number) => void
  hallMode: boolean
  onHallMode: (v: boolean) => void
  breathMode: boolean
  onBreathMode: (v: boolean) => void
  onOpenSettings: () => void
}

export function ControlTray({
  chordId,
  onChordId,
  octaveShift,
  onOctaveShift,
  hallMode,
  onHallMode,
  breathMode,
  onBreathMode,
  onOpenSettings,
}: ControlTrayProps) {
  return (
    <div className="tray">
      <div className="tray-label">Chord</div>
      <div className="segmented" role="group" aria-label="Chord type">
        {CHORD_TYPES.map((c) => (
          <button
            key={c.id}
            className={`seg${chordId === c.id ? ' is-on' : ''}`}
            onClick={() => onChordId(c.id)}
            aria-pressed={chordId === c.id}
            title={c.label}
          >
            {c.short}
          </button>
        ))}
      </div>

      <div className="tray-row">
        <button
          className={`pill${breathMode ? ' is-on' : ''}`}
          onClick={() => onBreathMode(!breathMode)}
          aria-pressed={breathMode}
        >
          <MicIcon />
          <span>Breath</span>
        </button>

        <button
          className={`pill${hallMode ? ' is-on' : ''}`}
          onClick={() => onHallMode(!hallMode)}
          aria-pressed={hallMode}
          title="Cut through a room full of singers"
        >
          <HallIcon />
          <span>Hall</span>
        </button>

        <div className="pill pill-stepper" role="group" aria-label="Octave">
          <button
            onClick={() => onOctaveShift(Math.max(-1, octaveShift - 1))}
            disabled={octaveShift <= -1}
            aria-label="Octave down"
          >
            −
          </button>
          <span className="stepper-value">
            {octaveShift > 0 ? `+${octaveShift}` : octaveShift}
          </span>
          <button
            onClick={() => onOctaveShift(Math.min(1, octaveShift + 1))}
            disabled={octaveShift >= 1}
            aria-label="Octave up"
          >
            +
          </button>
        </div>

        <button
          className="pill pill-icon"
          onClick={onOpenSettings}
          aria-label="Settings"
        >
          <GearIcon />
        </button>
      </div>
    </div>
  )
}

// --- icons ------------------------------------------------------------------

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Z" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" />
    </svg>
  )
}

function HallIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z" />
      <path d="M16 9a4.5 4.5 0 0 1 0 6M18.8 6.4a8 8 0 0 1 0 11.2" />
    </svg>
  )
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.8v2.4M12 18.8v2.4M4.5 12H2.1M21.9 12h-2.4M6.7 6.7 5 5M19 19l-1.7-1.7M17.3 6.7 19 5M5 19l1.7-1.7" />
    </svg>
  )
}
