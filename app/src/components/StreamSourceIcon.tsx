import { SourceIcon } from './SourceIcon.tsx'
import type { Stream } from '../lib/types.ts'

function leadSourceId(stream: Stream): string {
  return stream.sources[0]?.source.id || stream.id
}

export function StreamSourceIcon({ id, name, stream, className }: { id?: string; name?: string; stream?: Stream; className?: string }) {
  const sourceId = id || (stream ? leadSourceId(stream) : '')
  // 站点域名由后端给（包的 homepage）；只在 id 就是头一个成员时才借它的，显式传进来的 id 不猜。
  const lead = !id ? stream?.sources[0]?.source : undefined
  return (
    <SourceIcon
      id={sourceId}
      name={name || stream?.description || sourceId}
      facilityKey={lead?.facility?.key}
      site={lead?.site}
      className={className}
    />
  )
}

