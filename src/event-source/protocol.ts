export interface HelloFrame { t: 'hello'; source: string; domains: string[] }
export interface EventFrame { t: 'event'; id: string; source: string; receivedAt: number; payload: string }
export interface AckFrame { t: 'ack'; ids: string[] }
export interface CookiesFrame { t: 'cookies'; pairs: string }
export type Frame = HelloFrame | EventFrame | AckFrame | CookiesFrame

const KINDS = new Set(['hello', 'event', 'ack', 'cookies'])

export function encodeFrame(f: Frame): string {
  return JSON.stringify(f)
}

export function decodeFrame(raw: string): Frame {
  const o = JSON.parse(raw) as { t?: unknown }
  if (typeof o?.t !== 'string' || !KINDS.has(o.t)) throw new Error(`bad frame: ${raw.slice(0, 80)}`)
  return o as Frame
}
