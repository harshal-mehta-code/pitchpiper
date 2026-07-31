import { CHORD_TYPES, STACK_ID } from '../music/notes'

/**
 * How the pipe is sounded.
 *
 * These were two independent toggles — Breath and Drone — that silently turned
 * each other off, which meant the one rule governing them was the one thing you
 * could not see. Three exclusive choices state it outright, and they read as
 * what they are: the same instrument, played three ways.
 */
export type PlayMode = 'touch' | 'breath' | 'drone'

export interface ControlTrayProps {
  chordId: string
  onChordId: (id: string) => void
  playMode: PlayMode
  onPlayMode: (m: PlayMode) => void
  octaveShift: number
  onOctaveShift: (v: number) => void
  hallMode: boolean
  onHallMode: (v: boolean) => void
  /** Shown only when it isn't 440 — a setting you've changed is worth a badge. */
  a4: number
  onOpenSettings: () => void
  /**
   * Drops the controls that only mean something while the pipe is the thing on
   * screen. The chord picker stays, because in the tuner it chooses what is
   * being listened for.
   */
  compact?: boolean
  /** What the chord picker is doing right now. */
  label?: string
}

export function ControlTray({
  chordId,
  onChordId,
  playMode,
  onPlayMode,
  octaveShift,
  onOctaveShift,
  hallMode,
  onHallMode,
  a4,
  onOpenSettings,
  compact,
  label = 'Chord',
}: ControlTrayProps) {
  return (
    <div className="tray">
      <div className="tray-label">{label}</div>
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
        <button
          className={`seg seg-stack${chordId === STACK_ID ? ' is-on' : ''}`}
          onClick={() => onChordId(STACK_ID)}
          aria-pressed={chordId === STACK_ID}
          aria-label="Build your own"
          title="Build your own — tap holes on the pipe"
        >
          <StackIcon />
        </button>
      </div>

      {/* Two groups rather than a row of loose pills. They will not all fit
          across a phone, and wrapping them individually strands the last one
          alone on a second row; wrapping as groups puts how-you-play on one
          line and the adjustments on the next, which reads as a decision. */}
      <div className="tray-row">
        {!compact && (
          <div
            className="segmented tray-group"
            role="group"
            aria-label="How the pipe sounds"
          >
            <button
              className={`seg seg-mode${playMode === 'touch' ? ' is-on' : ''}`}
              onClick={() => onPlayMode('touch')}
              aria-pressed={playMode === 'touch'}
              title="Hold the middle of the pipe to sound it"
            >
              <TouchIcon />
              <span>Touch</span>
            </button>
            <button
              className={`seg seg-mode${playMode === 'breath' ? ' is-on' : ''}`}
              onClick={() => onPlayMode('breath')}
              aria-pressed={playMode === 'breath'}
              title="Blow at your phone"
            >
              <MicIcon />
              <span>Breath</span>
            </button>
            <button
              className={`seg seg-mode${playMode === 'drone' ? ' is-on' : ''}`}
              onClick={() => onPlayMode('drone')}
              aria-pressed={playMode === 'drone'}
              title="Keep the pitch sounding with nothing held down"
            >
              <DroneIcon />
              <span>Drone</span>
            </button>
          </div>
        )}

        <div className="tray-group">
          <div className="pill pill-stepper" role="group" aria-label="Octave">
            {/* A bare minus-nought-plus could be adjusting anything. */}
            <span className="stepper-tag" aria-hidden="true">
              Oct
            </span>
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

          {!compact && (
            <button
              className={`pill${hallMode ? ' is-on' : ''}`}
              onClick={() => onHallMode(!hallMode)}
              aria-pressed={hallMode}
              title="Cut through a room full of singers"
            >
              <HallIcon />
              <span>Hall</span>
            </button>
          )}

          {/* Silent at 440, impossible to miss anywhere else. A chorus that has
              been at 442 all evening should never have to go looking. */}
          {a4 !== 440 && (
            <button
              className="pill pill-badge"
              onClick={onOpenSettings}
              title="Concert pitch — tap to change"
            >
              A={a4}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// --- icons ------------------------------------------------------------------

/** Three notes stacked up — what the custom picker builds. */
function StackIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="7" cy="17.5" r="2.2" />
      <circle cx="12" cy="12" r="2.2" />
      <circle cx="17" cy="6.5" r="2.2" />
    </svg>
  )
}

/** A fingertip on the hub. */
function TouchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10 11V6.2a1.8 1.8 0 0 1 3.6 0V13" />
      <path d="M13.6 10.8a1.7 1.7 0 0 1 3.4 0v4.4a5.4 5.4 0 0 1-5.4 5.4h-.7a4 4 0 0 1-3.1-1.5l-2.6-3.3a1.6 1.6 0 0 1 2.3-2.2L10 15" />
    </svg>
  )
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Z" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" />
    </svg>
  )
}

/** A tone that just keeps going — a flat line with a wave riding on it. */
function DroneIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2 12h3.2c1 0 1.4-5 2.6-5s1.6 10 2.7 10 1.6-8 2.7-8 1.5 3 2.4 3H22" />
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
