function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&') // must run last — otherwise it double-decodes e.g. &amp;lt; → <
}

/** Parse bilibili's danmaku XML (`<d p="time,mode,size,color,...">text</d>`) into a
 *  flat list. `p`'s first field is the send-time offset in seconds. */
export function parseDanmakuXml(xml: string): Array<{ time: number; text: string }> {
  const out: Array<{ time: number; text: string }> = []
  const re = /<d p="([^"]*)">([^<]*)<\/d>/g
  let match: RegExpExecArray | null
  while ((match = re.exec(xml))) {
    const time = Number(match[1].split(',')[0])
    if (Number.isFinite(time)) out.push({ time, text: decodeXmlEntities(match[2]) })
  }
  return out
}
