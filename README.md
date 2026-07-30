# Pipe Dream

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

## Deploy to Vercel

The repo is ready to import — `vercel.json` sets the framework, build command
and output directory, so there is nothing to configure.

1. Go to [vercel.com/new](https://vercel.com/new) and import
   `harshal-mehta-code/pitchpipe`.
2. Pick the `claude/pitch-pipe-app-design-4whe67` branch (or merge it to `main`
   first and deploy that).
3. Deploy. You'll get a shareable `https://…vercel.app` link.

Or from the CLI:

```bash
npx vercel --prod
```

## Layout

```
src/
  audio/
    engine.ts     reed synthesis, master chain, hall mode, detent clicks
    breath.ts     microphone gate — energy + spectral flatness
  music/
    notes.ts      the thirteen holes, tuning maths, barbershop voicings
  ui/
    PitchDisc.tsx the brass disc (canvas)
    ControlTray.tsx, BreathMeter.tsx, SettingsSheet.tsx
  hooks/          wake lock, persisted preferences
```

Everything runs client-side. No backend, no accounts, no analytics.

## Controls

| | |
|---|---|
| Drag the ring | spin the pipe |
| Tap a note | jump to it |
| Hold the middle | sound it |
| Space | sound it (desktop) |
| ← / → | previous / next note |

## Not built yet

The agreed v1 is the pipe itself. Still to come:

- **Cold Call** — a daily pitch you have to sing from memory with no reference,
  scored in cents, with a Wordle-style shareable result grid.
- **Pitch Lock** — live cents meter, hold the pitch to score.
- **Setlist links** — a setlist encoded in the URL so a director shares one link
  and the whole chorus has the same starting pitches.
- **Tag library** — the four starting notes for a stack of barbershop tags.
- **Flat-drift report** — how far the chorus sagged over a run-through.
