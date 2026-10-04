import { Avatar, AvatarFallback, AvatarImage } from './acrylic/avatar.tsx'
import { cn } from '../lib/utils.ts'

/** Author/source avatar: a real avatar (the post's author / uploader) or a
 *  site favicon (RSS), either way filling the frame. Falls back to the name
 *  initial when neither loads. */
export function SourceAvatar({
  realAvatar,
  favicon,
  name,
  className,
}: {
  realAvatar?: string
  favicon?: string
  name: string
  className?: string
}) {
  const initial = (name || '?').slice(0, 1).toUpperCase()
  return (
    <Avatar className={cn('shrink-0', className)}>
      {realAvatar ? (
        <AvatarImage src={realAvatar} referrerPolicy="no-referrer" alt={name} />
      ) : favicon ? (
        <AvatarImage src={favicon} referrerPolicy="no-referrer" alt={name} />
      ) : null}
      <AvatarFallback>{initial}</AvatarFallback>
    </Avatar>
  )
}
