/**
 * The empty state shared by the chord tuner and the ring test.
 *
 * Its own file rather than living in either of them, because both need it and
 * importing one from the other would make the two views depend on each other
 * for a paragraph of copy.
 */
/*
 * What to say when there is nothing to listen for yet.
 *
 * Two different situations, and they used to share one line of copy that sent
 * you to the other screen for both. Picking a chord can be done right here, on
 * the tray directly below — so say so, and point down. Building a custom set
 * genuinely needs the disc, so offer to go there rather than describing the
 * journey.
 */
export function NeedsChord({
  isCustom,
  onGoToPipe,
}: {
  isCustom: boolean
  onGoToPipe: () => void
}) {
  if (isCustom) {
    return (
      <div className="needs-chord">
        <p className="hint">
          A custom set is built by tapping holes on the pipe. Two notes is the
          minimum — one voice has nothing to be in tune with.
        </p>
        <button className="chip wide" onClick={onGoToPipe}>
          Build it on the pipe
        </button>
      </div>
    )
  }
  return (
    <div className="needs-chord">
      <p className="hint">
        Pick <strong>Chord</strong> just below and this listens to every part at
        once. One note on its own has nothing to be in tune with.
      </p>
      <div className="needs-chord-arrow" aria-hidden="true">
        ↓
      </div>
    </div>
  )
}
