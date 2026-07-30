/**
 * Opening the microphone.
 *
 * Two features want the microphone now — breath input and the tuner — and the
 * awkward parts of getting one are identical for both: the constraint ladder
 * Safari needs, the audio-session dance iOS needs, and turning a DOMException
 * into something a person can act on. All of that lives here so neither feature
 * has to know about it, and so the session type is restored exactly once when
 * the last listener lets go.
 */

import { setAudioSessionType } from './engine'

export type MicErrorKind = 'denied' | 'missing' | 'busy' | 'unsupported' | 'error'

export interface MicResult {
  stream: MediaStream | null
  kind?: MicErrorKind
  /** What the browser actually said, when it said anything useful. */
  detail?: string
}

/**
 * How many callers currently hold an open microphone. The audio session only
 * goes back to playback-only when this reaches zero — putting it back while
 * another feature is still listening would cut that feature off mid-note.
 */
let holders = 0

/**
 * Apple's mobile platforms, however the browser is badged.
 *
 * Every browser on iOS and iPadOS is WebKit underneath, so this is a platform
 * test rather than a browser test. It exists for exactly one reason: those
 * platforms drop playback volume for as long as a capture track is live, and
 * no web API can override the output port. Feature detection would be
 * preferable and isn't available — `navigator.audioSession` only appears in
 * Safari 17, while the routing behaviour goes back much further.
 */
export function isAppleMobile(): boolean {
  const ua = navigator.userAgent
  if (/iPhone|iPad|iPod/.test(ua)) return true
  // iPadOS 13+ reports itself as a Mac; touch points give it away.
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1
}

/**
 * Whether continuous breath control is worth having on as the default.
 *
 * Everywhere except Apple's mobile platforms it simply works, and following
 * your breath the way a real reed does is the better instrument — so that is
 * the default there. On iOS it is still offered, and still works; it is just
 * quiet through the built-in speaker, which is fine on headphones and not fine
 * in front of a chorus.
 */
export function prefersPuffMode(): boolean {
  return isAppleMobile()
}

/**
 * Open a capture track, unprocessed if the browser will allow it.
 *
 * Every one of the processors we turn off is designed to remove exactly the
 * signal we want: noise suppression will happily erase breath as "background
 * noise", automatic gain fights the pressure mapping, and echo cancellation
 * will chase our own reed. Safari is fussier about audio constraints than
 * Chrome and fails the whole call over a single one it dislikes, so ask for the
 * ideal setup and walk down from there.
 *
 * Must be reached synchronously from a user gesture on Safari — see
 * `getAudio()` for why nothing may be awaited before this point.
 */
export async function openMicrophone(
  deviceId: string | null,
): Promise<MicResult> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return {
      stream: null,
      kind: 'unsupported',
      detail:
        window.isSecureContext === false
          ? 'Microphone needs a secure (https) connection.'
          : 'This browser has no microphone access.',
    }
  }

  // Safari will not open the microphone while the page's audio session is
  // declared playback-only, which is how we start up so the ringer switch
  // can't silence the pipe. Move it before asking.
  holders++
  setAudioSessionType('play-and-record')

  const raw = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  }
  const device = deviceId ? { deviceId: { exact: deviceId } } : {}
  const attempts: MediaStreamConstraints[] = [
    { audio: { ...device, ...raw, channelCount: 1 } },
    { audio: { ...device, ...raw } },
    { audio: { ...device } },
    // Last resort drops the device pin too, so a headset that has since
    // disconnected can't lock the feature out entirely.
    { audio: true },
  ]

  let stream: MediaStream | null = null
  let lastError: unknown = null
  for (const constraints of attempts) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints)
      break
    } catch (err) {
      lastError = err
      // A refusal is final. Retrying just re-prompts for something the person
      // has already declined.
      const name = (err as DOMException)?.name
      if (name === 'NotAllowedError' || name === 'SecurityError') break
    }
  }

  if (stream) return { stream }

  releaseSession()
  const name = (lastError as DOMException)?.name ?? ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return { stream: null, kind: 'denied' }
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return { stream: null, kind: 'missing', detail: 'No microphone found on this device.' }
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return { stream: null, kind: 'busy', detail: 'Another app is holding the microphone.' }
  }
  // Surface whatever the browser actually said. A generic "unavailable" is
  // impossible to act on and impossible to debug remotely.
  const msg = (lastError as Error)?.message
  return {
    stream: null,
    kind: 'error',
    detail: [name, msg].filter(Boolean).join(': ') || 'Could not open the microphone.',
  }
}

/**
 * Hand a stream back. Stopping the tracks is what clears the browser's
 * recording indicator, and dropping the last one puts the audio session back to
 * playback-only so the ringer switch stops mattering again.
 */
export function closeMicrophone(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop())
  releaseSession()
}

function releaseSession() {
  holders = Math.max(0, holders - 1)
  if (holders === 0) setAudioSessionType('playback')
}

/**
 * Input devices to choose from. Labels only exist once permission has been
 * granted, so this is worth calling after the microphone is already open.
 */
export async function listAudioInputs(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return []
  try {
    const all = await navigator.mediaDevices.enumerateDevices()
    return all.filter((d) => d.kind === 'audioinput')
  } catch {
    return []
  }
}
