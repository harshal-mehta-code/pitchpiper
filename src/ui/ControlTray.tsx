import { CHORD_TYPES } from '../music/notes'

/**
 * What the pipe gives you.
 *
 * Three genuinely different kinds of thing, and they used to share a row with
 * the chord types — "single note" listed as though it were a kind of chord, a
 * custom stack as though it were another, and no room to add a sixth chord
 * without the row falling off a phone. Splitting them puts the chord types one
 * level down, where any number of them can live.
 */
export type PitchMode = 'note' | 'chord' | 'custom'

export interface ControlTrayProps {
  pitchMode: PitchMode
  onPitchMode: (m: PitchMode) => void
  chordId: string
  onChordId: (id: string) => void
  breathMode: boolean
  onBreathMode: (v: boolean) => void
  octaveShift: number
  onOctaveShift: (v: number) => void
  hallMode: boolean
  onHallMode: (v: boolean) => void
  /** Shown only when it isn't 440 — a setting you've changed is worth a badge. */
  a4: number
  onOpenSettings: () => void
  /**
   * Drops the controls that only mean something while the pipe is the thing on
   * screen. The pitch picker stays, because in the tuner it chooses what is
   * being listened for — and so does the note stepper, because otherwise
   * choosing a target would mean leaving the tuner to do it.
   */
  compact?: boolean
  /** Steps the root note. Only rendered in the tuner, where there is no disc. */
  noteLabel?: string
  onNoteStep?: (delta: number) => void
  /** What the pitch picker is doing right now. */
  label?: string
}

export function ControlTray({
  pitchMode,
  onPitchMode,
  chordId,
  onChordId,
  breathMode,
  onBreathMode,
  octaveShift,
  onOctaveShift,
  hallMode,
  onHallMode,
  a4,
  onOpenSettings,
  compact,
  noteLabel,
  onNoteStep,
  label = 'Give',
}: ControlTrayProps) {
  const chords = CHORD_TYPES.filter((c) => c.id !== 'unison')

  return (
    <div className="tray">
      <div className="tray-label">{label}</div>

      <div className="segmented" role="group" aria-label="What the pipe gives">
        <button
          className={`seg seg-kind${pitchMode === 'note' ? ' is-on' : ''}`}
          onClick={() => onPitchMode('note')}
          aria-pressed={pitchMode === 'note'}
          title="One pitch on its own"
        >
          Note
        </button>
        <button
          className={`seg seg-kind${pitchMode === 'chord' ? ' is-on' : ''}`}
          onClick={() => onPitchMode('chord')}
          aria-pressed={pitchMode === 'chord'}
          title="A four-part voicing, with the selected pitch as the bass"
        >
          Chord
        </button>
        <button
          className={`seg seg-kind${pitchMode === 'custom' ? ' is-on' : ''}`}
          onClick={() => onPitchMode('custom')}
          aria-pressed={pitchMode === 'custom'}
          title="Build your own — tap holes on the pipe"
        >
          Custom
        </button>
      </div>

      {/* Only when there is a chord to be a type of. Wraps rather than scrolls,
          so a sixth and a seventh voicing can be added without this becoming a
          row that hides its own contents. */}
      {pitchMode === 'chord' && (
        <div className="chord-types" role="group" aria-label="Chord type">
          {chords.map((c) => (
            <button
              key={c.id}
              className={`chord-type${chordId === c.id ? ' is-on' : ''}`}
              onClick={() => onChordId(c.id)}
              aria-pressed={chordId === c.id}
              title={c.label}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}

      <div className="tray-row">
        {compact && onNoteStep && (
          <div className="pill pill-stepper" role="group" aria-label="Pitch">
            <button onClick={() => onNoteStep(-1)} aria-label="Lower pitch">
              −
            </button>
            <span className="stepper-value stepper-note">{noteLabel}</span>
            <button onClick={() => onNoteStep(1)} aria-label="Higher pitch">
              +
            </button>
          </div>
        )}

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

        {/* Breath is an extra input you switch on, not a mode that takes the
            instrument away: the middle of the pipe keeps working either way.
            That is why it is a plain toggle again and not one of a set. */}
        {!compact && (
          <button
            className={`pill${breathMode ? ' is-on' : ''}`}
            onClick={() => onBreathMode(!breathMode)}
            aria-pressed={breathMode}
            title="Blow at your phone to sound it"
          >
            <MicIcon />
            <span>Breath</span>
          </button>
        )}

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
