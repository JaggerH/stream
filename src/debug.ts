/** Shared debug-entry shapes for the frontend DebugBox. Kept at the top level (not under http/
 *  or audio/) so any producer — the HTTP resolve route, the download queue, the video path —
 *  can import the type without a cross-layer dependency. The transport (ring + WS) lives in
 *  http/debug-log.ts; this file is types only. */

export type DebugTone = 'ok' | 'warn' | 'bad' | 'muted'

/** One labelled row of an entry's detail, rendered uniformly. `tone` drives color. */
export interface DebugField {
  label: string
  value: string
  tone?: DebugTone
}

export interface DebugEntry {
  /** unique per emit (channel:key@at) */
  id: string
  at: number
  /** flow this came from, e.g. 'audio-resolve' | 'download' | 'video-resolve' */
  channel: string
  /** subject id within the channel, e.g. '<platform>:123' (取歌解析) */
  key: string
  /** short human title (falls back to key) */
  title: string
  /** one-line plain-language "what happened" */
  summary: string
  /** overall health → coloring / filtering */
  ok: boolean
  /** structured detail rendered as labelled rows */
  fields: DebugField[]
}
