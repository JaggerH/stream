import { MessageSquare, ThumbsUp } from 'lucide-react'
import { cn } from '../lib/utils.ts'
import { Avatar, AvatarFallback, AvatarImage } from './acrylic/avatar.tsx'
import { Badge } from './acrylic/badge.tsx'
import {
  Item,
  ItemContent,
  ItemFooter,
  ItemGroup,
  ItemMedia,
  ItemMeta,
  ItemTitle,
} from './acrylic/item.tsx'
import type { Comment } from '../lib/types.ts'

function fmtCount(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n)
}

/** Some sources hand back a comment with no text and no html — a sticker/emoji-only
 *  reply the harvester couldn't capture (Comment has no media field to fall back to).
 *  Rendering it is just a blank row, so it's dropped rather than shown empty. */
function hasBody(c: Comment): boolean {
  return !!c.text?.trim() || !!c.html?.trim()
}

const BADGE_STYLE: Record<string, string> = {
  UP: 'bg-pink-500/15 text-pink-500 hover:bg-pink-500/15',
  OP: 'bg-amber-500/15 text-amber-600 hover:bg-amber-500/15',
}

/** Body copy renders at reading size regardless of row density — a comment can carry
 *  a whole paragraph (or sanitized HTML with links/code), so unlike a title/meta line
 *  it doesn't shrink to the Item kit's compact-list type scale. */
function CommentBody({ c }: { c: Comment }) {
  const className = 'mt-1 break-words text-[14px] leading-relaxed text-foreground/90'
  if (c.html)
    return (
      <div
        className={cn(className, '[&_a]:break-all [&_a]:text-primary [&_a]:underline [&_p]:my-1 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2 [&_pre]:text-xs')}
        dangerouslySetInnerHTML={{ __html: c.html }}
      />
    )
  return <div className={cn(className, 'whitespace-pre-wrap')}>{c.text}</div>
}

function CommentNode({ c, compact, depth }: { c: Comment; compact: boolean; depth: number }) {
  // Nested/secondary content drops one density tier instead of keeping the parent's
  // size and hand-tuning its padding — see acrylic-ui's Post comment thread.
  const size = compact || depth > 0 ? 'xs' : 'sm'
  const replies = !compact && depth === 0 ? (c.replies ?? []).filter(hasBody) : []
  return (
    <>
      <Item variant={depth > 0 ? 'muted' : 'default'} size={size}>
        <ItemMedia variant="avatar">
          <Avatar>
            <AvatarImage src={c.avatar} referrerPolicy="no-referrer" alt={c.author} />
            <AvatarFallback>{(c.author ?? '?').slice(0, 1)}</AvatarFallback>
          </Avatar>
        </ItemMedia>
        <ItemContent>
          <div className="flex flex-wrap items-center gap-1.5">
            <ItemTitle className="w-auto">{c.author}</ItemTitle>
            {c.badges?.map((b) => (
              <Badge
                key={b}
                size="sm"
                variant={BADGE_STYLE[b] ? 'default' : 'secondary'}
                className={BADGE_STYLE[b] ?? ''}
              >
                {b}
              </Badge>
            ))}
            {c.ip && <ItemMeta className="shrink-0">{c.ip}</ItemMeta>}
            {!compact && !!c.like && (
              <ItemMeta className="ml-auto inline-flex shrink-0 items-center gap-1">
                <ThumbsUp className="size-3.5" />
                {fmtCount(c.like)}
              </ItemMeta>
            )}
          </div>
          <CommentBody c={c} />
          {!compact && !!replies.length && (
            <ItemFooter className="pt-1.5 text-[11px]">
              <span className="inline-flex items-center gap-1">
                <MessageSquare className="size-3.5" />
                {replies.length}
              </span>
            </ItemFooter>
          )}
        </ItemContent>
      </Item>
      {replies.map((r) => (
        <CommentNode key={r.id} c={r} compact={compact} depth={depth + 1} />
      ))}
    </>
  )
}

/** Renders normalized comments. `compact` = list peek, flat; default = detail modal,
 *  showing top-level comments plus one reply level (rendered as recessed `muted`
 *  rows right under the parent — no left-indent rail, matching how a nested Item
 *  reads as "inside" its container elsewhere in the kit). Rows separate on the
 *  `ItemGroup` gap alone, no hairline — see acrylic-ui's Post comment thread. */
export function CommentList({ comments, compact = false }: { comments: Comment[]; compact?: boolean }) {
  return (
    <ItemGroup>
      {comments.filter(hasBody).map((c) => (
        <CommentNode key={c.id} c={c} compact={compact} depth={0} />
      ))}
    </ItemGroup>
  )
}
