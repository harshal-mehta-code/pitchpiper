/**
 * Recording a snippet, as raw samples.
 *
 * MediaRecorder would be less code and would hand back something playable for
 * free, but it hands back *compressed* audio, and every lossy codec works by
 * throwing away spectral detail it judges inaudible. The whole ring analysis
 * is a question about spectral detail — partials a couple of hertz apart, some
 * of them thirty decibels down. So this takes the samples straight off the
 * capture graph and keeps them.
 *
 * An AudioWorklet does that on the audio thread where it belongs. The worklet
 * is compiled from a string into a blob URL rather than shipped as its own
 * file, which keeps it working offline from the service worker cache with no
 * build configuration. Where worklets aren't available — older WebKit —
 * ScriptProcessorNode does the same job on the main thread, deprecated but
 * universally present.
 */

import { closeMicrophone, openMicrophone, type MicErrorKind } from './mic'
import type { Recording } from './ring'

/** Hard ceiling on a take, so a forgotten recording can't eat the tab. */
export const MAX_SECONDS = 12
/** Below this a take is too short to say anything about. */
export const MIN_SECONDS = 1.5

const WORKLET_NAME = 'pp-capture'
const WORKLET_SOURCE = `
class Capture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(4096)
    this.at = 0
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.at++] = ch[i]
      if (this.at === this.buf.length) {
        // Posted in blocks rather than per 128-sample render quantum, which
        // would be several hundred messages a second for no benefit.
        this.port.postMessage(this.buf.slice(0))
        this.at = 0
      }
    }
    return true
  }
}
registerProcessor('${WORKLET_NAME}', Capture)
`

export interface RecorderStart {
  ok: boolean
  kind?: MicErrorKind
  detail?: string
}

export class SnippetRecorder {
  private stream: MediaStream | null = null
  private ctx: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private node: AudioNode | null = null
  private sink: GainNode | null = null
  private chunks: Float32Array[] = []
  private total = 0
  private startedAt = 0

  /** 0..1 peak of the most recent block, for the level meter. */
  level = 0
  recording = false

  async start(context: AudioContext, deviceId: string | null): Promise<RecorderStart> {
    if (this.recording) return { ok: true }
    const result = await openMicrophone(deviceId)
    if (!result.stream) {
      return { ok: false, kind: result.kind, detail: result.detail }
    }

    this.stream = result.stream
    this.ctx = context
    this.chunks = []
    this.total = 0
    this.level = 0
    this.source = context.createMediaStreamSource(this.stream)

    const limit = MAX_SECONDS * context.sampleRate
    const take = (block: Float32Array) => {
      if (!this.recording || this.total >= limit) return
      this.chunks.push(block)
      this.total += block.length
      let peak = 0
      for (let i = 0; i < block.length; i++) {
        const v = Math.abs(block[i])
        if (v > peak) peak = v
      }
      this.level = peak
    }

    let node: AudioNode | null = null
    if (context.audioWorklet) {
      try {
        const url = URL.createObjectURL(
          new Blob([WORKLET_SOURCE], { type: 'application/javascript' }),
        )
        await context.audioWorklet.addModule(url)
        URL.revokeObjectURL(url)
        const worklet = new AudioWorkletNode(context, WORKLET_NAME)
        worklet.port.onmessage = (e) => take(e.data as Float32Array)
        node = worklet
      } catch {
        node = null
      }
    }
    if (!node) {
      // Deprecated, and still the only thing that works on older WebKit.
      const sp = context.createScriptProcessor(4096, 1, 1)
      sp.onaudioprocess = (e) => take(new Float32Array(e.inputBuffer.getChannelData(0)))
      node = sp
    }

    this.source.connect(node)
    // A ScriptProcessorNode only runs while it is connected onward, so both
    // node types go to a silent sink. Routing a live microphone to the actual
    // speakers in a room full of singers would be a feedback disaster.
    this.sink = context.createGain()
    this.sink.gain.value = 0
    node.connect(this.sink)
    this.sink.connect(context.destination)
    this.node = node

    this.recording = true
    this.startedAt = performance.now()
    return { ok: true }
  }

  /** Seconds captured so far. */
  get elapsed(): number {
    return this.recording ? (performance.now() - this.startedAt) / 1000 : 0
  }

  /** Stop, release the microphone, and hand back everything captured. */
  stop(): Recording | null {
    if (!this.recording || !this.ctx) return null
    this.recording = false
    const sampleRate = this.ctx.sampleRate

    try {
      if (this.node instanceof AudioWorkletNode) this.node.port.onmessage = null
      else if (this.node) (this.node as ScriptProcessorNode).onaudioprocess = null
    } catch {
      /* already torn down */
    }
    this.source?.disconnect()
    this.node?.disconnect()
    this.sink?.disconnect()
    this.source = null
    this.node = null
    this.sink = null
    if (this.stream) closeMicrophone(this.stream)
    this.stream = null

    if (!this.total) return null
    const samples = new Float32Array(this.total)
    let at = 0
    for (const c of this.chunks) {
      samples.set(c, at)
      at += c.length
    }
    this.chunks = []
    return { samples, sampleRate }
  }

  /** Throw the take away without analysing it. */
  cancel() {
    this.stop()
    this.chunks = []
    this.total = 0
  }
}

/** Wrap captured samples so they can be played back through the graph. */
export function toAudioBuffer(ctx: AudioContext, rec: Recording): AudioBuffer {
  const buffer = ctx.createBuffer(1, rec.samples.length, rec.sampleRate)
  // Copied through a plainly-backed array: copyToChannel's type demands a
  // Float32Array over an ArrayBuffer specifically, and samples arriving from a
  // worklet port are typed as being over any buffer kind.
  const flat = new Float32Array(new ArrayBuffer(rec.samples.length * 4))
  flat.set(rec.samples)
  buffer.copyToChannel(flat, 0)
  return buffer
}
