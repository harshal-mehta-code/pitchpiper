import type { BreathResponse } from '../App'
import { Sheet } from './Sheet'

export interface SettingsSheetProps {
  open: boolean
  onClose: () => void
  a4: number
  onA4: (v: number) => void
  useFlats: boolean
  onUseFlats: (v: boolean) => void
  justTuning: boolean
  onJustTuning: (v: boolean) => void
  keepAwake: boolean
  onKeepAwake: (v: boolean) => void
  sensitivity: number
  onSensitivity: (v: number) => void
  smoothing: number
  onSmoothing: (v: number) => void
  breathMode: boolean
  onRecalibrate: () => void
  volume: number
  onVolume: (v: number) => void
  breathResponse: BreathResponse
  onBreathResponse: (v: BreathResponse) => void
  micInputs: MediaDeviceInfo[]
  micDeviceId: string | null
  onMicDevice: (id: string | null) => void
  onTour: () => void
}

export function SettingsSheet(props: SettingsSheetProps) {
  return (
    <Sheet open={props.open} title="Settings" onClose={props.onClose}>
      <>
        <Section>Sound</Section>

        <Row label="Concert pitch" value={`A = ${props.a4} Hz`}>
          <input
            type="range"
            min={430}
            max={446}
            step={1}
            value={props.a4}
            onChange={(e) => props.onA4(Number(e.target.value))}
          />
          <p className="hint">Match whatever the piano is doing.</p>
        </Row>

        <Row label="Volume" value={`${Math.round(props.volume * 100)}%`}>
          <input
            type="range"
            min={0.1}
            max={1}
            step={0.05}
            value={props.volume}
            onChange={(e) => props.onVolume(Number(e.target.value))}
          />
        </Row>

        <Row
          label="Chord tuning"
          value={props.justTuning ? 'Just' : 'Equal temperament'}
        >
          <div className="switch-row">
            <button
              className={`chip${props.justTuning ? ' is-on' : ''}`}
              onClick={() => props.onJustTuning(true)}
            >
              Just
            </button>
            <button
              className={`chip${!props.justTuning ? ' is-on' : ''}`}
              onClick={() => props.onJustTuning(false)}
            >
              Equal
            </button>
          </div>
          {/* One line. A setting that needs five to justify itself is either
              the wrong setting or the wrong default, and a paragraph of theory
              in a settings sheet is read by nobody and skimmed past by
              everybody — it belongs where somebody went looking for it. */}
          <p className="hint">
            Just is how barbershop is sung, and why chords ring. Equal if you
            are tuning to a piano.
          </p>
        </Row>

        <Row label="Note names" value={props.useFlats ? 'Flats' : 'Sharps'}>
          <div className="switch-row">
            <button
              className={`chip${!props.useFlats ? ' is-on' : ''}`}
              onClick={() => props.onUseFlats(false)}
            >
              F♯ G♯ A♯
            </button>
            <button
              className={`chip${props.useFlats ? ' is-on' : ''}`}
              onClick={() => props.onUseFlats(true)}
            >
              G♭ A♭ B♭
            </button>
          </div>
        </Row>

        <Section>Breath</Section>

        <Row
          label="How breath sounds it"
          value={props.breathResponse === 'puff' ? 'One puff' : 'Follows breath'}
        >
          <div className="switch-row">
            <button
              className={`chip${props.breathResponse === 'puff' ? ' is-on' : ''}`}
              onClick={() => props.onBreathResponse('puff')}
            >
              One puff
            </button>
            <button
              className={`chip${props.breathResponse === 'live' ? ' is-on' : ''}`}
              onClick={() => props.onBreathResponse('live')}
            >
              Follows breath
            </button>
          </div>
          <p className="hint">
            Follows breath tracks you as you blow. One puff fires the chord and
            lets the microphone go, which is louder on an iPhone.
          </p>
        </Row>

        {props.micInputs.length > 1 && (
          <Row label="Microphone">
            <select
              className="select"
              value={props.micDeviceId ?? ''}
              onChange={(e) => props.onMicDevice(e.target.value || null)}
            >
              <option value="">Automatic</option>
              {props.micInputs.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Input ${i + 1}`}
                </option>
              ))}
            </select>
            <p className="hint">
              If blowing does nothing, pick the phone's own microphone — headsets
              strip breath out as noise.
            </p>
          </Row>
        )}

        <Row
          label="Breath sensitivity"
          value={props.breathMode ? undefined : 'Breath mode is off'}
        >
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={props.sensitivity}
            disabled={!props.breathMode}
            onChange={(e) => props.onSensitivity(Number(e.target.value))}
          />
          <div className="range-ends">
            <span>Needs a real puff</span>
            <span>Hair trigger</span>
          </div>
          <button
            className="chip wide"
            onClick={props.onRecalibrate}
            disabled={!props.breathMode}
          >
            Re-listen to the room
          </button>
          <p className="hint">Stay quiet for a second while it measures.</p>
        </Row>

        <Row
          label="Breath smoothing"
          value={props.breathResponse === 'live' ? undefined : 'Follows breath only'}
        >
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={props.smoothing}
            disabled={props.breathResponse !== 'live'}
            onChange={(e) => props.onSmoothing(Number(e.target.value))}
          />
          <div className="range-ends">
            <span>Crisp</span>
            <span>Legato</span>
          </div>
          <p className="hint">
            How far the reed coasts through a gap in the breath.
          </p>
        </Row>

        <Section>Rehearsal</Section>

        <Row label="Keep screen awake" value={props.keepAwake ? 'On' : 'Off'}>
          <div className="switch-row">
            <button
              className={`chip${props.keepAwake ? ' is-on' : ''}`}
              onClick={() => props.onKeepAwake(true)}
            >
              On
            </button>
            <button
              className={`chip${!props.keepAwake ? ' is-on' : ''}`}
              onClick={() => props.onKeepAwake(false)}
            >
              Off
            </button>
          </div>
        </Row>

        {/* Also here, not only behind the question mark. Settings is where
            people go looking when they cannot find something, and being told
            "it's the other button" by an app that could simply have offered it
            is a small, avoidable insult. */}
        <Row label="How it works" value="A minute">
          <button className="chip wide" onClick={props.onTour}>
            Take the tour
          </button>
        </Row>

        <div className="sheet-about">
          <strong>Pitch Piper</strong> — thirteen holes, F to F. Add it to your
          home screen and it works with no signal.
        </div>

        <button className="sheet-close" onClick={props.onClose}>
          Done
        </button>
      </>
    </Sheet>
  )
}


/**
 * A heading every few rows.
 *
 * This sheet has grown to nine controls, and nine equal rows in a scrolling
 * panel is a list you read rather than a panel you scan. Three headings turn it
 * back into somewhere you can find one thing.
 */
function Section({ children }: { children: React.ReactNode }) {
  return <div className="sheet-section">{children}</div>
}

function Row({
  label,
  value,
  children,
}: {
  label: string
  value?: string
  children: React.ReactNode
}) {
  return (
    <div className="sheet-row">
      <div className="sheet-row-head">
        <span className="sheet-row-label">{label}</span>
        {value && <span className="sheet-row-value">{value}</span>}
      </div>
      {children}
    </div>
  )
}
