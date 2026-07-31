/**
 * Setlists, and sharing one as a link.
 *
 * The problem this solves is a real one and entirely unglamorous: a director
 * knows the starting pitch for every song in the book, and nobody else does. So
 * a setlist is just saved pitches with names on them — and because the whole
 * list fits in a URL, sharing it needs no account, no backend and no upload.
 * The director sends one link before rehearsal and the whole chorus opens the
 * same list.
 *
 * Encoding is deliberately compact rather than pretty. A twenty-song list has
 * to survive being pasted into a group chat, and chat apps truncate.
 */

import { CHORD_TYPES, STACK_ID } from './notes'

export interface SetlistEntry {
  id: string
  name: string
  noteIndex: number
  chordId: string
  octaveShift: number
  /** Only meaningful when chordId is the stack. */
  stack: number[]
}

/** The hash key a shared link arrives under. */
export const SETLIST_HASH = 'set'

export function newEntryId(): string {
  return Math.random().toString(36).slice(2, 9)
}

/**
 * Chord ids travel as an index into CHORD_TYPES, with -1 for the stack. Ids
 * like "dom7" would cost four times as much for no benefit, and a link that a
 * chat app cuts in half is worse than no link.
 */
function chordToCode(id: string): number {
  if (id === STACK_ID) return -1
  const i = CHORD_TYPES.findIndex((c) => c.id === id)
  return i < 0 ? 0 : i
}

function codeToChord(code: number): string {
  if (code === -1) return STACK_ID
  return CHORD_TYPES[code]?.id ?? CHORD_TYPES[0].id
}

type Packed = [string, number, number, number, number[]?]

export function encodeSetlist(list: SetlistEntry[]): string {
  const packed: Packed[] = list.map((e) => {
    const row: Packed = [e.name, e.noteIndex, chordToCode(e.chordId), e.octaveShift]
    if (e.chordId === STACK_ID && e.stack.length) row.push(e.stack)
    return row
  })
  return base64UrlEncode(JSON.stringify(packed))
}

/**
 * Returns null for anything that isn't a setlist we can trust.
 *
 * This parses a string a stranger controls, so every field is checked rather
 * than cast. A malformed link should do nothing at all, not put the pipe into
 * some impossible state.
 */
export function decodeSetlist(encoded: string): SetlistEntry[] | null {
  let raw: unknown
  try {
    raw = JSON.parse(base64UrlDecode(encoded))
  } catch {
    return null
  }
  if (!Array.isArray(raw)) return null

  const out: SetlistEntry[] = []
  for (const row of raw) {
    if (!Array.isArray(row)) continue
    const [name, noteIndex, chordCode, octaveShift, stack] = row as Packed
    if (typeof name !== 'string' || typeof noteIndex !== 'number') continue
    if (typeof chordCode !== 'number' || typeof octaveShift !== 'number') continue
    out.push({
      id: newEntryId(),
      // A name from a link ends up rendered as text, and an unbounded one would
      // wreck the layout of everyone the list was sent to.
      name: name.slice(0, 60),
      noteIndex: clampInt(noteIndex, 0, 12),
      chordId: codeToChord(chordCode),
      octaveShift: clampInt(octaveShift, -1, 1),
      stack: Array.isArray(stack)
        ? stack
            .filter((n): n is number => typeof n === 'number')
            .map((n) => clampInt(n, 0, 24))
            .slice(0, 25)
        : [],
    })
    if (out.length >= 200) break
  }
  return out.length ? out : null
}

/** The link to send. Absolute, because it is going into somebody's messages. */
export function setlistLink(list: SetlistEntry[]): string {
  const base = `${location.origin}${location.pathname}`
  return `${base}#${SETLIST_HASH}=${encodeSetlist(list)}`
}

/** Pull a shared list out of the address bar, if this was opened from a link. */
export function setlistFromLocation(): SetlistEntry[] | null {
  const hash = location.hash.replace(/^#/, '')
  if (!hash.startsWith(`${SETLIST_HASH}=`)) return null
  return decodeSetlist(hash.slice(SETLIST_HASH.length + 1))
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v) || 0))
}

function base64UrlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + '==='.slice((b64.length + 3) % 4)
  const bin = atob(padded)
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}
