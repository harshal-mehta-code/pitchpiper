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

**The middle sounds it, and does both jobs.** Hold it and you get the note for
as long as you hold it. Tap it and the note stays on until you tap again — the
middle then reads *tap to stop*, so the question "how do I turn this off"
answers itself in the place it came up. Sounding a note and leaving one running
used to be two controls on opposite sides of the screen with nothing on either
saying they were related; they are one gesture with two lengths, which is how a
walkie-talkie, a torch and a car horn all already work.

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
the one it gave you. Tap **Tuner** at the top and it will. Everything it listens
for is set from the tuner itself — the note, the chord, the octave — so nothing
here ever sends you back to the other screen to answer a question it asked.

*Listen* does not ask you what you are about to do. One voice gets its note
named and a needle showing how far off it is, plus a running average — the
flat-drift number, which is how you find out that the chorus sagged fourteen
cents over a run-through. Let three more people in and the panel becomes four
meters, one per part: who's flat, who's sharp, who isn't there.

This used to be two modes with a switch between them, which was the app making
its own internal split into somebody else's decision. How many people are
singing is not a preference — it is a fact, the analyser already tracks it with
hysteresis because it has to, and the panel can simply follow. It is quick to
open up when a chord arrives and slow to give it up, because the gap between two
phrases is a breath, not the end of the chord. The panel lights in
proportion to how much of the chord is locked. Because the pipe already knows
what the chord is *meant* to be, this doesn't have to solve blind four-part
transcription — it only has to look in the right places, which is both tractable
and the actual question a director has.

But "the right places" are not fixed frequencies, and assuming they were is what
made this unusable. A chorus does not sing where the pipe put the chord: the
pitch was given twenty seconds ago, and half a semitone of collective drift over
a verse is unremarkable. Measured against absolute pitch, every part reads as
missing, and a chord locked perfectly to itself reads as four singers who are
all equally wrong. So the whole expected *shape* — which is known exactly, even
when its position is not — is slid across the spectrum until its harmonics line
up with the ones that are there, and each part is then measured against the
chord's own centre. Being flat as a chorus is free. Only disagreeing with each
other costs anything, which is also the only thing anybody can act on. The
collective drift is still reported, once, in the corner of the panel.

A part that stops being heard for a frame doesn't blink out, either. A frame is
a third of a second of evidence about people who are breathing and singing
consonants, and deciding "heard" or "not heard" frame by frame turns that into a
row flickering thirty times a second — not a measurement anyone can read, and
not a fault anyone can fix. Evidence accumulates and decays, so a part has to go
genuinely missing before it is called missing. And a part sung an octave from
where the voicing puts it is named as that rather than reported as silence,
because "the tenor is an octave down" is a real thing that happens in a
rehearsal and is fixed the moment somebody says it.

**The ring test.** The thing barbershop actually chases. Sing a chord at it,
hold it, and it tells you whether the chord *rang* — and if not, who broke it.

Ringing isn't mysticism, it's arithmetic. When every part is a whole-number
ratio of the bass, all four voices put partials at exactly the same frequencies
— on the rungs of the bass's own harmonic series — and those partials add
coherently. Miss the ratio by a few cents and the same partials land a few hertz
apart instead, and two things a few hertz apart don't add, they beat.

So the report is a **ladder**: the bass's harmonic series, rung by rung, showing
which voices meet on each one and whether they locked or how many times a second
they're beating. In a barbershop seventh the lead meets the bass on rung 2, the
third on rung 5, and the seventh on rung 7 — and that seventh rung is where the
style lives. Underneath: each part's tuning against the bass, and the recording
to play back.

The verdict is a sentence, not a number. There was a score out of 100 here in
the largest type in the app, and it was the least honest quantity in it: four
seconds of four people does not resolve to a point, and a figure you can watch
tick from 71 to 73 turns listening into optimising a readout. The score survives
as the thing that chooses the sentence. A spectrogram and a per-block trace went
with it — both were lovely to build and neither is anything a person reads in a
rehearsal, which is the whole test.

Everything is measured against the bass **as you actually sang it** — found by
starting from the pitch the pipe just gave out and confirming it against the
whole chord's shape, rather than by taking the lowest strong peak in the
recording, which in a rehearsal hall is a handling thump or an air conditioner.
A root wrong by a fifth makes every rung in the report wrong. A chorus flat as a
whole rings perfectly well; only disagreeing with each other costs anything, and
the score says so.

**Setlists, shared as a link.** The problem is unglamorous and completely real:
the director knows the starting pitch for every song in the book, and nobody
else does. Save each pitch with a song name against it, and the list is there on
stage. Then send it — the entire setlist travels inside the URL, so the whole
chorus opens the same list with no account, no sign-in and nothing uploaded
anywhere. A list that arrives by link is shown and offered, never merged on your
behalf.

**Custom.** The third of the three things the pipe can give you turns the disc
into a note picker: tap holes to stack them. Any set of notes you like, sounded
together — a diminished chord, two notes to check an interval, the whole scale
at once. The set is remembered, and the tuner will listen for it just like a
preset chord.

A hole is either in or out; that is all a hole does. Choosing a note and
choosing which octave it sits in are two different decisions, and a tap that did
both meant taking a note back out — the thing people do constantly — cost three
taps and made you listen to a state you never wanted on the way past. The octave
now lives on the note itself: every note you have picked is listed under the
disc, and tapping one moves it an octave.

The disc deliberately does **not** turn to a hole you tap here. Every hole is on
screen the whole time, so the rotation bought nothing and made picking four
notes feel like a fight; instead the hole ripples where your thumb landed, the
phone buzzes, and the pipe stays put. Untouched holes wear a dotted ring so it
is obvious all thirteen are live, and a note an octave up wears a second one.

**Chord Bloom.** Give the whole four-part chord instead of blowing four notes in
a row. Major, barbershop 7th, minor 7th and major 6th, voiced Bass / Bari /
Lead / Tenor with the selected pitch as the bass. Each part's actual note is
printed under the disc so you can read them out.

The pipe gives you one of three things — **Note**, **Chord** or **Custom** — and
the chord *types* live one level below that, appearing only once Chord is what
you asked for. They used to share a single row: "single note" listed as though
it were a kind of chord, a custom stack as though it were another, and no room
to add a fifth voicing without the row running off the side of a phone.

**Just intonation.** Barbershop is sung in just intonation, not equal
temperament, and the difference *is* the style. When every part is a whole-number
ratio of the bass, all four voices put their overtones in exactly the same
places, those partials add coherently instead of beating, and the chord rings —
you hear notes nobody is singing. So that is what the pipe gives you, and what
the tuner judges you against. The barbershop seventh sits 31 cents below where a
piano would put it, and it is meant to; a tuner that measured you against equal
temperament would tell a perfectly locked chord it was badly flat. Equal
temperament is one tap away for when you're tuning to a piano.

**Breath is an extra input, not a mode.** Turning it on doesn't take the
instrument away — the middle of the pipe keeps working exactly as it did. That
is why it is a plain toggle and not one of a set of ways to play: there is only
one way to play, and breath is another way to reach it.

While the microphone is open, smoke streams up from the bottom of the screen and
spills around the pipe, faster and thicker the harder you blow, with denser
puffs breathing out through the holes that are actually sounding. Blowing at a
phone otherwise gives you nothing at all to go on — you cannot hear yourself
over the speaker — and a drift of it when nothing is happening doubles as *it is
listening*.

It responds from the faintest breath, not from a hard one. That took fixing the
signal rather than the picture: it was drawn from the reed's own drive, which is
zero until the gate opens and is then measured against a ceiling that climbs to
match your hardest-ever blow — so an ordinary breath after one big one read as
almost nothing, and the smoke only really appeared at full blast. It now comes
from a separate, continuous measure anchored to the room the detector has been
tracking rather than to a personal best, on a logarithmic scale, because the
range from a breath you can barely feel to a hard one spans two orders of
magnitude and a linear map is saturated by the second-quietest thing that
happens.

How *much* smoke there is and how *fast* it moves are then read off that one
signal with different curves. Volume answers "can it hear me", so it climbs
steeply at the bottom and is half of full at a breath too soft to sound the
pipe. Speed answers "how hard am I blowing", so it keeps climbing at the top,
where there is somewhere left to go once the screen is already full. Between
them the whole range says something.

Three things turn a bag of particles into something that reads as fluid, and
skipping any one of them gets you lint: each puff is a soft blob far bigger than
the gap to its neighbour, so the eye sees a body rather than a scatter of marks;
near the disc the flow is pushed outward along the radius, falling off with the
square of distance, so it spills round the rim like air round something solid;
and two sine terms of differing frequency, sampled at each puff's own position
and drifting with time, stand in for a curl-noise field so the stream braids and
folds instead of running in parallel lines. Puffs also grow as they age and
smear along their own velocity, which is most of what separates a volume of gas
from a dot with an opacity.

One puff mode gets a gust rather than a stream. The microphone is released the
instant the puff fires, so no frame ever reports the breath at full pressure;
taken literally that left the air invisible on exactly the platform where one
puff is the default. What actually happened is a hard breath, so that is what
gets drawn, and it decays into a wake.

**Hall Mode.** A phone speaker against forty singers in a church basement is a
losing fight. Hall Mode drops the lows the speaker can't produce anyway,
saturates for upper harmonics so the ear reconstructs the missing fundamental,
pushes a presence bump where hearing is most sensitive, and compresses hard.

**A tour you have to ask for.** Seven steps, about a minute, and not a
slideshow: it puts a light on the real control on the real screen and leaves the
whole app working underneath, so each step names one thing to try and ticks
itself off the moment you do it. Next is always there whether or not you did the
thing, Back goes back, and Escape leaves — a tour you cannot walk out of is an
interrogation. Steps whose lesson you already know quietly drop their prompt
rather than asking you to do something you have done, and so do steps you have
already carried out and then stepped back to.

A step ticks on the thing it promised rather than on the tap that asked for it.
The breath step is the one that matters: the Breath switch is on the instant it
is pressed, but the phone answers with a permission sheet over the whole screen,
so ticking there would mean the card that asked is two steps gone by the time
the prompt is answered. It waits for a microphone that is open, past the room
measurement, and actually listening. A prompt that never gets a yes leaves the
step exactly where it was.

Getting to it is the other half. There is no first-run modal, because a modal
arrives before anyone has a question, blocks the thing they opened the app to
do, and gets dismissed unread — which then counts, in the numbers, as onboarding
delivered. Instead the instrument lands first, and a second and a half later a
small bubble offers the tour from the corner. Waved off, it never asks again;
the **?** it points at keeps a dot until the tour has been opened once, so
changing your mind is always one tap. The one exception is somebody who turned
it down and then, for half a minute, never changed the note and never sounded
anything — that is not a person browsing, it is a person looking at an
instrument they haven't worked out how to play, and they get asked once more,
worded for it. Never a third time.

It teaches the spine and not the map: pick, sound, chord, breath, setlist,
tuner. Custom stacks, hall mode and concert pitch are deliberately absent —
they are discoverable where they live, and the tour that gets finished teaches
more than the thorough one abandoned on card four.

**Rehearsal-hall details.** Screen stays awake. Works fully offline once
installed to your home screen. A=430–446 tuning. Sharps or flats. Octave shift.
Everything remembered between sessions. On modern iOS it plays through the
ringer switch.

## Try it locally

```bash
npm install
npm run dev
npm test
```

## Tests

The tuner's whole job is the one thing that cannot be checked by running the
app: it needs four people holding a chord, and the interesting cases are the
ones where they are holding it slightly wrong in a way somebody has to be told
about. So the singers are synthetic — a realistic partial rolloff, a formant,
vibrato at a different rate per voice, and a room with more noise low down,
where a phone in a rehearsal hall genuinely lives — and the ground truth is an
argument. Every claim above about what the tuner does is a test: a locked chord
sung a semitone flat still rings, one part out is the one part named, an
equal-tempered seventh is 31 cents and says so, a silent part reads as silent
rather than as perfect, and a part that drops out for a frame does not blink.

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

The smoke costs real fill rate, so it is not drawn when nobody can see it — a
sheet over the disc, or the browser in the background — and not at all if the
system asks for reduced motion, which is exactly the setting someone turns on to
be rid of a screenful of drifting weather. The breath meter still reports what
the microphone hears either way. It is measured under software rasterisation,
where the whole app holds one frame per vsync.

**What a phone does to all this.** The suspicion that the handset is the
problem is a reasonable one, so it is tested rather than argued about: the
synthetic singers are put through a rehearsal hall, a preamp being driven by
forty people at arm's length, a capsule that cannot hear a bass, and the gain
control you are left with when a device refuses a raw capture. Ground truth
survives the trip, which is exactly what a real recording could not have given —
nobody knows what a quartet on a wax cylinder was actually tuned to.

Most of it turns out not to matter. A hall changes every partial's *level* and
none of their frequencies. Band-limiting and capsule hiss cost nothing. Gain
control pumps the level and leaves the pitch alone.

One of them matters a great deal and is the reason the design is what it is: a
phone cannot hear a bass. The port and the capsule roll off steeply below a
couple of hundred hertz, which is above the fundamental of every bass note this
pipe gives out — C3 is 131Hz. Through a 260Hz rolloff the bass's own fundamental
arrives about 24dB down on its second harmonic. Any scheme that measures a part
at its fundamental is measuring the quietest thing in the room, which is why
each part is measured across every harmonic it has and weighted, and why the
bass is still read to within a few cents when its fundamental is barely present.

And one is a genuine limit, pinned by a test that is expected to fail the day
somebody solves it. A saturating preamp makes energy at sums and differences of
everything present, and in a *justly tuned* chord those combinations are the
chord: twice the bari's harmonic seventh less the bass is 2 × 7/4 − 1 = 5/2,
which is the tenor's note exactly. The arithmetic that makes a just chord ring
is the arithmetic a nonlinearity runs, so distortion fills in a part nobody is
singing, at precisely the right pitch, with a harmonic series of its own, and
reports it as perfectly in tune. It takes under half a percent of distortion,
which a handset in front of a loud chorus comfortably produces. This is not a
peak picker that could be sharpened — the energy is really there, at really that
frequency. Telling the two apart needs a different kind of evidence entirely: an
intermodulation product's pitch wobbles with the *sum* of the vibrato of the
voices that made it, where a singer's wobbles on its own. That is a real signal
and a research problem, and it is not done here.

The practical version of that: if a part is silent and the microphone is being
driven hard, the tuner will claim that part is present and in tune. Backing the
phone off is the fix, and it is the same thing that makes everything else in
here more accurate.

One more, found while looking: the microphone is asked for raw — no gain
control, no noise suppression — but the request is a ladder, and its lower rungs
drop those flags rather than fail. On a device that refuses the raw constraints
the whole app gets processed audio and nothing downstream is told.

Known limits, honestly: iOS has no vibration API, so detents there are audible
but not tactile. Bluetooth headset microphones run their own noise suppression
that strips breath before the page ever sees it — the input picker lets you
force the built-in microphone instead. And a full chorus is spectrally
indistinguishable from broadband noise, so breath mode can misfire if it is
left on mid-song.

Three about the ring test. Beat rates are worked out from the measured
fundamentals rather than by watching each rung's level wobble, because watching
the wobble fails on the case that matters most — an equal-tempered seventh is
about 31 cents out, which at 1.8kHz is 32Hz of beating, and no window short
enough to see 32Hz is long enough to resolve the partials in the first place.
That does assume each voice's partials are whole multiples of its own
fundamental, which for a sustained sung note they are. Heavy vibrato will read
as a part that wanders, because from the outside it is one. And the recording is
taken as raw samples rather than through MediaRecorder: every lossy codec works
by discarding spectral detail, and spectral detail is the entire question here.

Two more about the tuner. Barbershop voicings collide with themselves: the
lead's octave sits exactly on the bass's second harmonic, and the bari's fifth
puts its own second harmonic on the bass's third. There is frequently nowhere in
the spectrum belonging to one singer alone, so rather than pick a single clean
harmonic — which may not exist, and if it does is often too high to be worth
finding — each part is measured at every harmonic it has, weighted by how much
of the point belongs to it, and combined with a weighted median. A captured
partial is not a slightly wrong reading, it is somebody else's, and a median
throws it out where a mean would average it in. Whether a part is *present* is a
different question and is only ever argued from points nothing else lands on: a
shared point sounds identical whether or not the part is singing. Where a part
has no such point anywhere, the row says **shared overtone**. And the reference
tone is dead on pitch and far louder at the microphone than anyone singing, so
holding it pauses the readings instead of quietly measuring the app against
itself.

## Layout

```
src/
  audio/
    engine.ts     reed synthesis, master chain, hall mode, detent clicks
    fft.ts        radix-2 FFT, for the analysis the AnalyserNode can't do
    spectrum.ts   noise floor, finding partials, harmonic salience
    chord.ts      where a sung chord is, where each part sits in it, holding still
    recorder.ts   raw-sample capture, worklet with a ScriptProcessor fallback
    ring.ts       the ring test — harmonic ladder, beat rates, scoring
    mic.ts        opening a capture track, and the platform quirks in doing so
    breath.ts     microphone gate — energy + spectral flatness
    analyzer.ts   pitch detection (autocorrelation), and the live chord path
  music/
    notes.ts      the thirteen holes, tuning maths, barbershop voicings
    setlist.ts    saved pitches, and packing a list into a URL
  ui/
    PitchDisc.tsx the brass disc (canvas), and the smoke over it
    TuneView.tsx  the tuner — the listening panel and the ring test
    RingView.tsx  recording, and the report afterwards
    NeedsChord.tsx what to say when there is nothing to listen for yet
    Sheet.tsx     the panel that slides up, and how to get back out of it
    Tour.tsx      the spotlight tour, and the tap on the shoulder that offers it
    SetlistSheet.tsx, ControlTray.tsx, BreathMeter.tsx, SettingsSheet.tsx
  hooks/          wake lock, persisted preferences
test/
  synth.ts        four synthetic singers, with vibrato, formants and a room
  phone.ts        a hall, a driven preamp, a capsule that cannot hear a bass
  chord.test.ts   the live listening panel
  ring.test.ts    the ring test
  phone.test.ts   all of the above, through a handset
```

Everything runs client-side. No backend, no accounts, no analytics.

`chord.ts` and `ring.ts` share one measurement, so the live panel and the report
afterwards cannot disagree about who was flat.

## Controls

| | |
|---|---|
| Hold the middle | sound it for as long as you hold |
| Tap the middle | leave it sounding; tap again to stop |
| Space | the same bargain, on a keyboard |
| Drag the ring | spin the pipe |
| Tap a note | jump to it |
| Tap a note in Custom | add or remove it — without moving the pipe |
| Tap a note under the disc | move that one an octave |
| ← / → | previous / next note |
| Pipe / Tuner, top right | the two screens |
| ? icon, top right | the tour |
| List icon, top right | the setlist |
| Sliders icon, top right | settings |

A sheet — settings, or the setlist — closes from the × in its header, by
dragging that header down, by tapping outside it, or with Escape. The header
never scrolls away, so the way out is on screen no matter how far down you are.
That matters more than it sounds: the contents scroll, so a swipe on the body is
a scroll and not a dismissal, and the panel is full width on a phone, which
means aiming at "just beside it" lands inside its own padding and taps whatever
row happens to be there. Reaching to leave and landing in a text field is about
the worst answer an interface can give.

Everything else is quiet until it isn't: concert pitch only appears on the tray
once you have moved it off 440, so the default case carries no badge at all and
a chorus that has been at 442 all evening cannot miss it.

## Not built yet

- **Cold Call** — a daily pitch you have to sing from memory with no reference,
  scored in cents, with a Wordle-style shareable result grid.
- **Pitch Lock** — hold a pitch against the clock to score.
