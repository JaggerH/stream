import { describe, it, expect } from 'vitest'
import { makeEnrichers } from './enrich.ts'
import { ValidationError } from '../../shared/package-sdk/errors.ts'

const client = {
  comments: async () => ({
    total: 3,
    pageSize: 20,
    page: 1,
    pinned: { rpid: 'p', author: 'A', avatar: '', text: '置顶', like: 1, isUp: true },
    comments: [{ rpid: 'c1', author: 'B', avatar: '', text: '正文', like: 0, isUp: false }],
  }),
  owner: async () => ({ mid: '1', name: 'UP', face: 'https://x/f.jpg' }),
  user: async () => ({ uid: '1', name: 'U', face: 'https://x/f.jpg' }),
  userByName: async (n: string) => (n === 'known' ? { uid: '2', name: 'known', face: '' } : null),
} as never

describe('bilibili-comments', () => {
  const run = (q: Record<string, string>) => makeEnrichers(client)['bilibili-comments'](q)
  it('第一页把置顶评论排在最前，并打上徽章', async () => {
    const r = (await run({ vid: 'BV1' })) as { comments: Array<{ id: string; badges?: string[] }>; total: number }
    expect(r.comments[0].id).toBe('p')
    expect(r.comments[0].badges).toContain('置顶')
    expect(r.total).toBe(3)
  })
  it('只有一页（3/20）→ cursor null；有下一页时是页码（见下面 50/20 那条）', async () => {
    expect(((await run({ vid: 'BV1' })) as { cursor: string | null }).cursor).toBeNull()
  })
  it('缺 vid → ValidationError（宿主翻 400）', async () => {
    await expect(run({})).rejects.toBeInstanceOf(ValidationError)
  })

  // 从 src/content/enrich/enrich.test.ts 搬来的那组（断言强度不减）：徽章顺序、置顶不重复、cursor 算法。
  it('置顶 + UP 主 → badges 顺序 [UP, 置顶]；正文里同一条不重复；50/20 → 第 1 页还有下一页', async () => {
    const calls: unknown[][] = []
    const c = {
      comments: async (...a: unknown[]) => {
        calls.push(a)
        return {
          total: 50,
          pageSize: 20,
          page: 1,
          pinned: { rpid: 'p', author: 'up', avatar: '', text: 'pinned', like: 9, rcount: 0, ctime: 0, isUp: true },
          comments: [
            { rpid: 'p', author: 'up', avatar: '', text: 'pinned', like: 9, rcount: 0, ctime: 0, isUp: true },
            { rpid: 'r1', author: 'x', avatar: '', text: 'hi', like: 3, rcount: 0, ctime: 0, isUp: false },
          ],
        }
      },
    } as never
    const e = (await makeEnrichers(c)['bilibili-comments']({ vid: 'BV1', page: '1' })) as {
      comments: Array<Record<string, unknown>>
      total: number
      cursor: string | null
    }
    expect(calls).toEqual([[{ bvid: 'BV1' }, 1]])
    expect(e.comments).toHaveLength(2)
    expect(e.comments[0]).toMatchObject({ id: 'p', badges: ['UP', '置顶'], author: 'up', text: 'pinned', like: 9 })
    expect(e.comments[1]).toMatchObject({ id: 'r1', text: 'hi', like: 3 })
    expect(e.comments[1].badges).toBeUndefined()
    expect(e.total).toBe(50)
    expect(e.cursor).toBe('2') // 50/20 → 3 pages, page 1 has more
  })

  it('末页 → cursor null；置顶不在第 2 页领头；av 号走 aid', async () => {
    const calls: unknown[][] = []
    const c = {
      comments: async (...a: unknown[]) => {
        calls.push(a)
        return {
          total: 25,
          pageSize: 20,
          page: 2,
          pinned: null,
          comments: [{ rpid: 'r9', author: 'y', avatar: '', text: 'last', like: 0, isUp: false }],
        }
      },
    } as never
    const e = (await makeEnrichers(c)['bilibili-comments']({ vid: 'av170001', page: '2' })) as {
      comments: Array<{ id: string }>
      cursor: string | null
    }
    expect(calls).toEqual([[{ aid: '170001' }, 2]])
    expect(e.comments.map((x) => x.id)).toEqual(['r9'])
    expect(e.cursor).toBeNull()
  })
})

describe('bilibili-owner / bilibili-user', () => {
  it('owner 接 bvid 或 aid，两个都缺 → ValidationError', async () => {
    const e = makeEnrichers(client)
    expect(await e['bilibili-owner']({ bvid: 'BV1' })).toEqual({ mid: '1', name: 'UP', face: 'https://x/f.jpg' })
    await expect(e['bilibili-owner']({})).rejects.toBeInstanceOf(ValidationError)
  })
  it('user 接 uid 或 name；查不到这个人 → ValidationError（404 在宿主那层没有入口，用 400 说清）', async () => {
    const e = makeEnrichers(client)
    // `url` 是作者主页：宿主前端的通用作者位照它画链接，站点 URL 只住在包里。
    expect(await e['bilibili-user']({ uid: '1' })).toEqual({ uid: '1', name: 'U', face: 'https://x/f.jpg', url: 'https://space.bilibili.com/1' })
    expect(await e['bilibili-user']({ name: 'known' })).toEqual({ uid: '2', name: 'known', face: '', url: 'https://space.bilibili.com/2' })
    await expect(e['bilibili-user']({ name: 'nobody' })).rejects.toBeInstanceOf(ValidationError)
    await expect(e['bilibili-user']({})).rejects.toBeInstanceOf(ValidationError)
  })
})
