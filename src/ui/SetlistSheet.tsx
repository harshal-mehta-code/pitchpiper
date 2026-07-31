import { useCallback, useEffect, useRef, useState } from 'react'
import { chordById, midiToName, noteLabel, PIPE_NOTES, STACK_ID } from '../music/notes'
import { newEntryId, setlistLink, type SetlistEntry } from '../music/setlist'
import { Sheet } from './Sheet'

/**
 * The setlist.
 *
 * A sheet rather than a screen, because this is something you open, take one
 * thing out of, and dismiss — the same shape as reaching into a folder. The
 * instrument stays behind it the whole time.
 */

export interface SetlistSheetProps {
  open: boolean
  onClose: () => void
  list: SetlistEntry[]
  onList: (next: SetlistEntry[]) => void
  useFlats: boolean
  /** What the pipe is set to right now, for the "save this" row. */
  current: { noteIndex: number; chordId: string; octaveShift: number; stack: number[] }
  onLoad: (entry: SetlistEntry) => void
  /** A list that arrived by link and hasn't been accepted yet. */
  incoming: SetlistEntry[] | null
  onAcceptIncoming: (mode: 'add' | 'replace') => void
  onDismissIncoming: () => void
}

export function SetlistSheet(props: SetlistSheetProps) {
  const { open, onClose } = props
  const [name, setName] = useState('')
  const [shared, setShared] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const add = useCallback(() => {
    props.onList([
      ...props.list,
      {
        id: newEntryId(),
        name: name.trim() || describe(props.current, props.useFlats),
        ...props.current,
      },
    ])
    setName('')
  }, [name, props])

  const share = useCallback(async () => {
    const url = setlistLink(props.list)
    // Three routes, because exactly one of them exists on any given device: the
    // OS share sheet on phones, the clipboard on desktop, and showing the link
    // to be copied by hand when a page isn't allowed to touch either.
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Starting pitches', text: 'Our starting pitches', url })
        return
      }
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url)
        setShared('Link copied.')
        window.setTimeout(() => setShared(null), 2400)
        return
      }
    } catch {
      // A cancelled share sheet lands here too, which is not an error worth
      // reporting — falling through to the visible link is harmless either way.
    }
    setShared(url)
  }, [props.list])

  const move = (i: number, by: number) => {
    const next = props.list.slice()
    const j = i + by
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    props.onList(next)
  }

  return (
    <Sheet open={open} title="Setlist" onClose={onClose}>
      <>
        {props.incoming && (
          <div className="incoming">
            <div className="incoming-title">
              A setlist arrived with this link — {props.incoming.length}{' '}
              {props.incoming.length === 1 ? 'song' : 'songs'}
            </div>
            <ul className="incoming-list">
              {props.incoming.slice(0, 6).map((e) => (
                <li key={e.id}>
                  {e.name} · {describe(e, props.useFlats)}
                </li>
              ))}
              {props.incoming.length > 6 && <li>and {props.incoming.length - 6} more…</li>}
            </ul>
            <div className="switch-row">
              <button className="chip" onClick={() => props.onAcceptIncoming('add')}>
                Add to mine
              </button>
              <button className="chip" onClick={() => props.onAcceptIncoming('replace')}>
                Replace mine
              </button>
              <button className="chip" onClick={props.onDismissIncoming}>
                No thanks
              </button>
            </div>
          </div>
        )}

        <div className="sheet-row">
          <div className="sheet-row-head">
            <span className="sheet-row-label">Save this pitch</span>
            <span className="sheet-row-value">
              {describe(props.current, props.useFlats)}
            </span>
          </div>
          <div className="save-row">
            <input
              className="text-input"
              value={name}
              placeholder="Song name"
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') add()
              }}
            />
            <button className="chip" onClick={add}>
              Save
            </button>
          </div>
        </div>

        {props.list.length === 0 ? (
          <p className="hint">
            Set the pipe to a song's starting pitch and save it. Do that for the
            whole book once, and you never work it out on stage again — then send
            the list to the chorus as a link.
          </p>
        ) : (
          <ul className="songs">
            {props.list.map((e, i) => (
              <li className="song" key={e.id}>
                <button
                  className="song-main"
                  onClick={() => {
                    props.onLoad(e)
                    onClose()
                  }}
                >
                  <span className="song-name">{e.name}</span>
                  <span className="song-pitch">{describe(e, props.useFlats)}</span>
                </button>
                <button
                  className="song-btn"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  aria-label={`Move ${e.name} up`}
                >
                  ↑
                </button>
                <button
                  className="song-btn"
                  onClick={() => props.onList(props.list.filter((x) => x.id !== e.id))}
                  aria-label={`Remove ${e.name}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        {props.list.length > 0 && (
          <>
            <button className="chip wide" onClick={share}>
              Share this setlist
            </button>
            {shared && <ShareResult value={shared} />}
            <p className="hint">
              The whole list travels inside the link itself — there's no account
              and nothing is uploaded anywhere.
            </p>
          </>
        )}

        <button className="sheet-close" onClick={onClose}>
          Done
        </button>
      </>
    </Sheet>
  )
}

/** Either a short confirmation or, as a last resort, the link to copy by hand. */
function ShareResult({ value }: { value: string }) {
  const ref = useRef<HTMLInputElement>(null)
  const isLink = value.startsWith('http')
  useEffect(() => {
    if (isLink) ref.current?.select()
  }, [isLink])
  if (!isLink) return <p className="hint share-note">{value}</p>
  return (
    <input className="text-input share-link" ref={ref} readOnly value={value} />
  )
}

/** "E♭ Barbershop 7th", or the notes themselves for a stack. */
function describe(
  e: { noteIndex: number; chordId: string; octaveShift: number; stack: number[] },
  useFlats: boolean,
): string {
  const note = PIPE_NOTES[e.noteIndex] ?? PIPE_NOTES[0]
  const label = noteLabel(note, useFlats)
  if (e.chordId === STACK_ID) {
    if (!e.stack.length) return label
    return e.stack
      .map((o) => midiToName(PIPE_NOTES[0].midi + o + e.octaveShift * 12, useFlats))
      .join(' ')
  }
  const chord = chordById(e.chordId)
  const octave = e.octaveShift ? ` ${e.octaveShift > 0 ? '+8ve' : '−8ve'}` : ''
  return chord.id === 'unison' ? `${label}${octave}` : `${label} ${chord.label}${octave}`
}
