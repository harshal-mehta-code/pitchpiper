import { CENTS_RANGE, IN_TUNE_CENTS } from '../audio/analyzer'

/**
 * One meter, used everywhere something is measured.
 *
 * There were five bar treatments in this app — the voice dial, a part's row,
 * the breath level, the recording level, a rung on the ladder — each drawn
 * slightly differently because each was drawn on the day it was needed. That is
 * a thing you feel rather than notice: nothing quite matches, so nothing looks
 * decided. This is the one gauge, in two sizes, milled into whatever plate it
 * sits on.
 *
 * The scale is cents either side of nothing, with a lit window over the middle
 * marking the range inside which a chord actually locks. That window is the
 * point of the whole thing — somebody singing cannot read a number off a
 * needle, but they can see whether it is in the light.
 */

export interface MeterProps {
  size?: 'sm' | 'lg'
  /** The meter body, for toggling `is-locked`. */
  ref?: React.Ref<HTMLDivElement>
  /** The needle, driven at frame rate from outside React. */
  needleRef?: React.Ref<HTMLDivElement>
}

/**
 * The lit window, measured rather than drawn.
 *
 * This was `left: 44%; width: 12%` in the stylesheet — which is ±6 cents on a
 * ±50 scale, worked out by hand and then written down as two percentages with
 * nothing to say where they came from. It agreed with the analyser only because
 * somebody lined it up once. Now the window *is* the lock range: widen
 * IN_TUNE_CENTS and the light widens with it.
 */
const half = (IN_TUNE_CENTS / CENTS_RANGE) * 50

export function Meter({ size = 'lg', ref, needleRef }: MeterProps) {
  return (
    <div className={`meter meter-${size}`} ref={ref}>
      <span
        className="meter-window"
        style={{ left: `${50 - half}%`, width: `${half * 2}%` }}
      />
      {/* Quarter marks. Two, not six: a scale you can count is a scale you
          stop reading, and the only positions that mean anything here are the
          middle and "past the middle by a lot". */}
      <span className="meter-tick" style={{ left: '25%' }} />
      <span className="meter-tick" style={{ left: '75%' }} />
      <span className="meter-centre" />
      <div className="meter-needle" ref={needleRef} />
    </div>
  )
}

/**
 * The verdict colours, named once.
 *
 * These resolve against the tokens in the stylesheet rather than repeating the
 * hexes here, which is what they used to do in three files — so a green that
 * meant "locked" in the tuner could drift away from the green that meant it in
 * the ring report without anybody touching either one.
 *
 * The same argument applies to the *thresholds*, which that fix left behind: a
 * bare `6` here decided the colour while the analyser's IN_TUNE_CENTS decided
 * whether the meter said locked — two independent sixes, three lines apart in
 * TuneView, either of which could have been tuned without the other. Green now
 * means locked because it is asking the same question.
 */
/** Past three times the lock range, a part is not close, it is wrong. */
const WAY_OUT_CENTS = IN_TUNE_CENTS * 3

export function centsColour(abs: number): string {
  if (abs <= IN_TUNE_CENTS) return 'var(--good)'
  if (abs <= WAY_OUT_CENTS) return 'var(--warn)'
  return 'var(--bad)'
}

export function lockColour(lock: number): string {
  if (lock > 0.8) return 'var(--good)'
  if (lock > 0.45) return 'var(--warn)'
  return 'var(--bad)'
}

/** A real minus sign, and no "-0¢" for something that is simply in tune. */
export function formatCents(c: number): string {
  const sign = c > 0.5 ? '+' : c < -0.5 ? '−' : ''
  return `${sign}${Math.abs(Math.round(c))}¢`
}
