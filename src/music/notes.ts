/**
 * A real chromatic pitch pipe (the Kratt "Master Key" every barbershop director
 * has rattling around in a jacket pocket) covers thirteen notes, F up to F.
 * We keep that exact layout — thirteen holes, F at the top — because muscle
 * memory from the physical object is worth more than a tidier abstraction.
 */

export const SEMITONES_IN_PIPE = 13

/** Display names. Sharps by default; flats are what choruses actually say. */
export interface NoteName {
  sharp: string
  flat: string
  /** True when sharp and flat spellings differ (i.e. it's a black key). */
  enharmonic: boolean
}

const NAMES: NoteName[] = [
  { sharp: 'F', flat: 'F', enharmonic: false },
  { sharp: 'F♯', flat: 'G♭', enharmonic: true },
  { sharp: 'G', flat: 'G', enharmonic: false },
  { sharp: 'G♯', flat: 'A♭', enharmonic: true },
  { sharp: 'A', flat: 'A', enharmonic: false },
  { sharp: 'A♯', flat: 'B♭', enharmonic: true },
  { sharp: 'B', flat: 'B', enharmonic: false },
  { sharp: 'C', flat: 'C', enharmonic: false },
  { sharp: 'C♯', flat: 'D♭', enharmonic: true },
  { sharp: 'D', flat: 'D', enharmonic: false },
  { sharp: 'D♯', flat: 'E♭', enharmonic: true },
  { sharp: 'E', flat: 'E', enharmonic: false },
  { sharp: 'F', flat: 'F', enharmonic: false },
]

export interface PipeNote {
  /** 0..12, position on the physical pipe. */
  index: number
  name: NoteName
  /** MIDI note number at octave shift 0. F3 = 53. */
  midi: number
}

/** F3 — the bottom hole of the pipe. */
const BASE_MIDI = 53

export const PIPE_NOTES: PipeNote[] = NAMES.map((name, index) => ({
  index,
  name,
  midi: BASE_MIDI + index,
}))

export function noteLabel(note: PipeNote, useFlats: boolean): string {
  return useFlats ? note.name.flat : note.name.sharp
}

const PC_SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
const PC_FLAT = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B']

/** Name any MIDI note — used to tell each part what they're singing. */
export function midiToName(midi: number, useFlats: boolean): string {
  const pc = ((Math.round(midi) % 12) + 12) % 12
  return (useFlats ? PC_FLAT : PC_SHARP)[pc]
}

/**
 * Name with its octave number, e.g. "E♭4". Worth the extra character in the
 * tuner, where knowing whether you landed an octave out is the whole point.
 */
export function midiToLabel(midi: number, useFlats: boolean): string {
  const n = Math.round(midi)
  return `${midiToName(n, useFlats)}${Math.floor(n / 12) - 1}`
}

/**
 * Concert pitch is a setting, not a constant. Plenty of choruses tune to 442,
 * and anyone rehearsing with a piano that hasn't been touched since 1998 will
 * want to nudge it too.
 */
export function midiToFreq(midi: number, a4 = 440): number {
  return a4 * Math.pow(2, (midi - 69) / 12)
}

export function freqToMidi(freq: number, a4 = 440): number {
  return 69 + 12 * Math.log2(freq / a4)
}

/** Signed cents between a measured frequency and a target frequency. */
export function centsBetween(freq: number, target: number): number {
  return 1200 * Math.log2(freq / target)
}

// ---------------------------------------------------------------------------
// Barbershop voicings
// ---------------------------------------------------------------------------

export type VoicePart = 'Bass' | 'Bari' | 'Lead' | 'Tenor'

/** Four parts, always listed low to high — the order the chord blooms in. */
export const VOICE_PARTS: VoicePart[] = ['Bass', 'Bari', 'Lead', 'Tenor']

export interface ChordType {
  id: string
  /** What you'd say out loud. */
  label: string
  /** Short form for the control tray. */
  short: string
  /**
   * Semitone offsets from the selected pitch, one per part in VOICE_PARTS
   * order. The selected pitch is the bass note — that's how a director thinks
   * about it ("give me the E flat").
   */
  offsets: Record<VoicePart, number>
}

export const CHORD_TYPES: ChordType[] = [
  {
    id: 'unison',
    label: 'Single note',
    short: '1',
    offsets: { Bass: 0, Bari: 0, Lead: 0, Tenor: 0 },
  },
  {
    // Root, fifth, root, third. The default because most songs start on a
    // major tonic and this is the cleanest spread voicing of it.
    id: 'major',
    label: 'Major',
    short: 'M',
    offsets: { Bass: 0, Bari: 7, Lead: 12, Tenor: 16 },
  },
  {
    // The barbershop seventh. The whole reason the style exists.
    id: 'dom7',
    label: 'Barbershop 7th',
    short: '7',
    offsets: { Bass: 0, Bari: 10, Lead: 12, Tenor: 16 },
  },
  {
    id: 'minor7',
    label: 'Minor 7th',
    short: 'm7',
    offsets: { Bass: 0, Bari: 10, Lead: 12, Tenor: 15 },
  },
  {
    id: 'major6',
    label: 'Major 6th',
    short: '6',
    offsets: { Bass: 0, Bari: 9, Lead: 12, Tenor: 16 },
  },
]

/**
 * The custom stack. Not a chord type in the musical sense — it's whatever set
 * of holes you've tapped, which is the escape hatch for everything the five
 * presets don't cover: a diminished chord, an ii-V, two notes to check an
 * interval, or a whole scale sounded at once for the fun of it.
 */
export const STACK_ID = 'stack'

export function chordById(id: string): ChordType {
  return CHORD_TYPES.find((c) => c.id === id) ?? CHORD_TYPES[0]
}

export interface ChordTone {
  /** Voice part for a preset voicing; the note's own name for a stack. */
  part: string
  midi: number
  freq: number
}

export function buildChord(
  note: PipeNote,
  chord: ChordType,
  octaveShift: number,
  a4: number,
): ChordTone[] {
  const root = note.midi + octaveShift * 12
  const tones = VOICE_PARTS.map((part) => {
    const midi = root + chord.offsets[part]
    return { part, midi, freq: midiToFreq(midi, a4) }
  })
  // A unison "chord" is one note, not four stacked in the same place.
  if (chord.id === 'unison') return [tones[0]]
  return tones
}

/**
 * Sound an arbitrary set of holes at once.
 *
 * A stack entry is a semitone offset from the bottom of the pipe, so 0..12 is
 * the pipe as engraved and 13..24 is the same hole an octave up. Storing it
 * that way rather than as {hole, octave} keeps the ordering, the de-duplication
 * and the maths all trivial.
 */
export function buildStack(
  offsets: number[],
  octaveShift: number,
  a4: number,
  useFlats: boolean,
): ChordTone[] {
  const base = BASE_MIDI + octaveShift * 12
  return [...new Set(offsets)]
    .sort((a, b) => a - b)
    .map((o) => {
      const midi = base + o
      return { part: midiToLabel(midi, useFlats), midi, freq: midiToFreq(midi, a4) }
    })
}

/** Highest offset a stack entry can take: the top hole, an octave up. */
export const MAX_STACK_OFFSET = SEMITONES_IN_PIPE - 1 + 12
