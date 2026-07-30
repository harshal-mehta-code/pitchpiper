# Pitch Piper

**A pitch pipe you actually want to pick up.** Built for barbershop chorus
rehearsals.

Thirteen holes, F to F — the same layout as the Kratt Master Key in your jacket
pocket. Spin the brass with your thumb, hold the middle, or just blow at your
phone.

---

## What it does

**The disc.** The whole app is one brushed-brass pitch pipe. Drag it and it
turns with real momentum, clicking and buzzing into each detent, coasting to a
stop and settling onto a note. Tap any engraved note to jump straight there.

**The sound.** Not a sine wave. A modelled free reed: a breathy chiff on the
attack, an upward pitch bend as air pressure builds, two reeds beating a few
cents apart, a bed of air noise, and a flat sag as the breath dies. It sounds
like an instrument because it's built like one.

**Breath input.** Turn on Breath and blow at the bottom of your phone — harder
breath gives a louder, brighter tone, exactly like the real thing. It tells
blowing apart from singing and from its own speaker using spectral flatness:
breath is broadband noise, voices and reeds are harmonic. Press-and-hold always
works too.

Nobody blows a perfectly steady stream at a phone, so the gate has a memory:
when it closes, the pressure is held and allowed to sag rather than dropped, and
a gap shorter than that hang sounds like a reed coasting instead of a switch
being flicked. How long it hangs is yours to set, from **Crisp** to **Legato**.

**The tuner.** A pitch pipe can't tell you whether the note you sang back was
the one it gave you. Tap the tuning fork in the corner and it will.

*One voice* names what you're singing and shows how far off it is, in cents,
with a needle you can read while you're still singing. It also keeps a running
average — the flat-drift number, which is how you find out that the chorus sagged
fourteen cents over a run-through.

*Whole chord* is the interesting one. Pick a chord on the pipe, sing it, and
every part gets its own meter: who's flat, who's sharp, who isn't there. The
whole panel lights up when all four are locked in. Because the pipe already
knows what the chord is *meant* to be, this doesn't have to solve blind
four-part transcription — it only has to look in the right places, which is both
tractable and the actual question a director has.

**Stack.** The `⁘` chord button turns the disc into a note picker: tap holes to
stack them, tap again to lift one an octave, tap once more to drop it. Any set
of notes you like, sounded together — a diminished chord, two notes to check an
interval, the whole scale at once. The stack is remembered, and the tuner will
listen for it just like a preset chord.

**Chord Bloom.** Give the whole four-part chord instead of blowing four notes in
a row. Major, barbershop 7th, minor 7th and major 6th, voiced Bass / Bari /
Lead / Tenor with the selected pitch as the bass. Each part's actual note is
printed under the disc so you can read them out.

**Hall Mode.** A phone speaker against forty singers in a church basement is a
losing fight. Hall Mode drops the lows the speaker can't produce anyway,
saturates for upper harmonics so the ear reconstructs the missing fundamental,
pushes a presence bump where hearing is most sensitive, and compresses hard.

**Rehearsal-hall details.** Screen stays awake. Works fully offline once
installed to your home screen. A=430–446 tuning. Sharps or flats. Octave shift.
Everything remembered between sessions. On modern iOS it plays through the
ringer switch.

## Try it locally

```bash
npm install
npm run dev
```

The microphone needs a secure context, so breath input works on `localhost` and
on any https deployment, but not over plain http to a LAN address.

## Deployment

Live at **[pitchpiper.vercel.app](https://pitchpiper.vercel.app)**.

Vercel builds from this repo's default branch on every push; `vercel.json` sets
the framework, build command and output directory, so there is nothing to
configure.

## Running everywhere

The target is every phone and browser a chorus might turn up with, so platform
differences are handled by capability rather than by assuming a platform. The
awkward ones, and what is done about them:

**An open microphone makes iOS quiet.** iOS and iPadOS pin the audio session to
`playAndRecord` for as long as any capture track is live, which routes output
away from the loudspeaker, and no web API can override the port. So breath
defaults to **one puff**: the breath fires the note, the microphone is dropped,
and the chord rings out at full volume before listening resumes.

**But letting go of the microphone can re-prompt.** Firefox grants microphone
access for a single use unless the person ticked "Remember", so re-acquiring
raises a fresh permission prompt — once per puff would be intolerable. Pausing
therefore takes one of two routes: fully release where an open microphone
actually costs something (Apple mobile), or where `navigator.permissions` can
confirm the grant is persistent and re-acquiring is silent; otherwise keep the
track and mute it, which is instant and can never prompt. Both routes are
tested.

**Freshly opened microphones spit out garbage.** The first frames of a capture
track are filters settling and gain ramping — loud and broadband, which is
exactly what breath looks like. Without a grace period the pipe retriggers
itself forever. Applies to every platform.

**Safari is fussier about constraints.** It fails a whole `getUserMedia` call
over a single constraint it dislikes, so constraints are tried as a ladder from
the ideal unprocessed mono capture down to plain `audio: true`.

**Safari needs the gesture.** The microphone prompt is only allowed while a user
gesture is still live, so `getUserMedia` is reached synchronously from the tap
rather than after awaiting the audio context.

Smaller ones: `webkitAudioContext` is accepted as a fallback; `createConicGradient`
falls back to a linear gradient for the brass; `dvh` units are paired with `vh`
so a browser without them doesn't collapse the layout; wake lock, vibration,
`enumerateDevices` and `navigator.audioSession` are all feature-detected and
simply do nothing where absent. Sample rates are read from the context rather
than assumed, so a narrowband headset stream is analysed only across the
bandwidth it actually carries.

Known limits, honestly: iOS has no vibration API, so detents there are audible
but not tactile. Bluetooth headset microphones run their own noise suppression
that strips breath before the page ever sees it — the input picker lets you
force the built-in microphone instead. And a full chorus is spectrally
indistinguishable from broadband noise, so breath mode can misfire if it is
left on mid-song.

Two more about the tuner. Barbershop voicings collide with themselves: the
lead's octave sits exactly on the bass's second harmonic, and the bari's fifth
puts its own second harmonic on the bass's third. Each part is therefore
measured at the lowest harmonic of its own that nothing else lands on — which
usually exists, and when it doesn't the row says **shared overtone** rather than
attributing a combined reading to one singer. And the reference tone is dead on
pitch and far louder at the microphone than anyone singing, so holding it pauses
the readings instead of quietly measuring the app against itself.

## Layout

```
src/
  audio/
    engine.ts     reed synthesis, master chain, hall mode, detent clicks
    mic.ts        opening a capture track, and the platform quirks in doing so
    breath.ts     microphone gate — energy + spectral flatness
    analyzer.ts   pitch detection (autocorrelation) and per-part chord tuning
  music/
    notes.ts      the thirteen holes, tuning maths, barbershop voicings
  ui/
    PitchDisc.tsx the brass disc (canvas)
    TuneView.tsx  the tuner — one voice, and the whole chord
    ControlTray.tsx, BreathMeter.tsx, SettingsSheet.tsx
  hooks/          wake lock, persisted preferences
```

Everything runs client-side. No backend, no accounts, no analytics.

## Controls

| | |
|---|---|
| Drag the ring | spin the pipe |
| Tap a note | jump to it |
| Tap a note in Stack | add it, lift it an octave, remove it |
| Hold the middle | sound it |
| Space | sound it (desktop) |
| ← / → | previous / next note |
| Tuning fork, top right | the tuner |

## Not built yet

- **Setlist links** — a setlist encoded in the URL so a director shares one link
  and the whole chorus has the same starting pitches.
- **Tag library** — the four starting notes for a stack of barbershop tags.
- **Cold Call** — a daily pitch you have to sing from memory with no reference,
  scored in cents, with a Wordle-style shareable result grid.
- **Pitch Lock** — hold a pitch against the clock to score.
