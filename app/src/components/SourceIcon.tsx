import { useEffect, useState } from 'react'
import { cn } from '../lib/utils.ts'
import { sourceIconFallbackUrl, sourceIconUrl } from '../lib/sourceIcon.ts'

/** The brand icon for a catalog source / channel — the platform logo via the Folo icon service
 *  (icons.folo.is/<domain>). The domain is the backend's `site.domain` (the owning package's
 *  homepage) when given, else the RSSHub namespace→domain map. Falls back to a lettered
 *  tile when the platform is unknown or the image fails to load. Sizing comes from the parent
 *  (e.g. an ItemMedia variant="image" box). */
export function SourceIcon({ id, name, facilityKey, site, className }: { id: string; name?: string; facilityKey?: string; site?: { domain: string }; className?: string }) {
  const url = sourceIconUrl(id, facilityKey, site?.domain)
  const fallbackUrl = sourceIconFallbackUrl(id, facilityKey, site?.domain)
  const [phase, setPhase] = useState<'primary' | 'fallback' | 'letter'>('primary')
  const src = phase === 'primary' ? url : phase === 'fallback' ? fallbackUrl : undefined

  useEffect(() => {
    setPhase('primary')
  }, [id, facilityKey, site?.domain])

  if (src) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        onError={() => setPhase(phase === 'primary' && fallbackUrl ? 'fallback' : 'letter')}
        className={cn('size-full object-cover', className)}
      />
    )
  }
  const ch = (name || id).replace(/^rsshub:/, '').trim().charAt(0).toUpperCase() || '?'
  return (
    <span className={cn('flex size-full items-center justify-center bg-muted text-[13px] font-semibold text-muted-foreground', className)}>
      {ch}
    </span>
  )
}
