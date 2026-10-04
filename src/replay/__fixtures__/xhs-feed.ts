import type { Recipe } from '../recipe.ts'

/** A hand-authored fetch recipe shaped like a real xhs search capture. Fixture only. */
export const XHS_FEED_RECIPE: Recipe = {
  version: 1,
  kind: 'fetch',
  sourceId: 'xhs-search',
  cookieDomain: 'xiaohongshu.com',
  entryUrl: 'https://www.xiaohongshu.com/search_result?keyword={keyword}',
  request: {
    url: '/api/sns/web/v1/search/notes?keyword={keyword}&cursor={cursor}&page_size=20',
    method: 'GET',
    headers: { accept: 'application/json' },
  },
  pagination: {
    mode: 'cursor',
    itemsAt: 'data.items',
    cursorFrom: 'data.cursor',
    cursorParam: 'cursor',
    hasMore: 'data.has_more',
    maxPages: 5,
  },
  assert: [
    { path: 'data.items', desc: 'no items array — likely a login-wall or the endpoint moved' },
    { path: 'data.cursor', desc: 'no cursor field — response schema changed' },
  ],
  mapping: {
    title: 'note_card.display_title',
    url: 'note_card.share_link',
    author: 'note_card.user.nickname',
    like_count: 'note_card.interact_info.liked_count',
  },
}

function note(title: string): unknown {
  return {
    note_card: {
      display_title: title,
      share_link: `https://www.xiaohongshu.com/explore/${title}`,
      user: { nickname: `user-${title}` },
      interact_info: { liked_count: 42 },
    },
  }
}

/** Two-page canned response keyed by the cursor value the request carries. */
export const XHS_FEED_PAGES: Record<string, unknown> = {
  '': { data: { has_more: true, cursor: 'p2', items: [note('a1'), note('a2')] } },
  p2: { data: { has_more: false, cursor: 'p3', items: [note('b1')] } },
}
