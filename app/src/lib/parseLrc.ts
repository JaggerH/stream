import type { AudioPlayerLyric } from '../components/acrylic/audio-player-stage.tsx'

const LINE_RE = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g

/** Parse an LRC string into time-sorted lyric lines. A line can carry multiple timestamp tags
 *  (a repeated chorus) — each tag produces its own entry. A line with no timestamp tag is
 *  dropped, not shown as untimed text — a lyrics source's own LRC feed usually tags every line, so
 *  this is not expected to fire in practice; if it does, [] tells the caller "nothing usable" and
 *  AudioPlayerStage hides its lyrics pane on an empty array (see design §4.2). */
export function parseLrc(raw: string): AudioPlayerLyric[] {
  const out: AudioPlayerLyric[] = []
  for (const line of raw.split(/\r?\n/)) {
    const tags = [...line.matchAll(LINE_RE)]
    if (!tags.length) continue
    const text = line.replace(LINE_RE, '').trim()
    if (!text) continue
    for (const m of tags) {
      const min = Number(m[1])
      const sec = Number(m[2])
      const frac = m[3] ? Number(m[3].padEnd(3, '0')) / 1000 : 0
      out.push({ time: min * 60 + sec + frac, text })
    }
  }
  return out.sort((a, b) => a.time - b.time)
}
