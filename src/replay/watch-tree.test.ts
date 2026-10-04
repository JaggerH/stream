import { describe, it, expect, vi } from 'vitest'
import { watchTree } from './watch-tree.ts'

/** 假 fs：只提供 watchTree 用到的两件事——列目录、挂监听。 */
function fakeFs(tree: Record<string, string[]>) {
  const watched = new Map<string, () => void>()
  const closed: string[] = []
  return {
    watched,
    closed,
    /** 触发某个目录上的监听回调（模拟文件系统事件） */
    fire: (dir: string) => watched.get(dir)?.(),
    setTree: (next: Record<string, string[]>) => { for (const k of Object.keys(tree)) delete tree[k]; Object.assign(tree, next) },
    deps: {
      listDirs: (dir: string) => {
        if (!(dir in tree)) throw new Error(`ENOENT ${dir}`)
        return tree[dir]!
      },
      watch: (dir: string, cb: () => void) => {
        watched.set(dir, cb)
        return { close: () => { closed.push(dir); watched.delete(dir) } }
      },
    },
  }
}

/** Node 在 Linux/WSL2 上的 `fs.watch({recursive:true})` 不是内核原生的，是 JS 层模拟——实测
 *  头两轮之后就再不投递事件（persistent 真假、句柄持不持有都一样），而非递归监听 12/12 全中。
 *  所以整棵树要自己按目录逐层挂非递归监听，新目录出现时补挂、目录消失时收掉。 */
describe('watchTree', () => {
  it('根目录和每一层子目录都挂上监听', () => {
    const tree = { '/r': ['/r/a', '/r/b'], '/r/a': ['/r/a/deep'], '/r/b': [], '/r/a/deep': [] }
    const f = fakeFs(tree)
    watchTree(['/r'], () => {}, f.deps)
    expect([...f.watched.keys()].sort()).toEqual(['/r', '/r/a', '/r/a/deep', '/r/b'])
  })

  it('不存在的根静默跳过（首跑还没建目录），不拖垮其他根', () => {
    const f = fakeFs({ '/r': [] })
    watchTree(['/r', '/missing'], () => {}, f.deps)
    expect([...f.watched.keys()]).toEqual(['/r'])
  })

  it('新装一个包（新目录出现）→ 下一次事件后它也被监听上', () => {
    const tree: Record<string, string[]> = { '/r': [], }
    const f = fakeFs(tree)
    const onChange = vi.fn()
    watchTree(['/r'], onChange, f.deps)
    expect([...f.watched.keys()]).toEqual(['/r'])

    f.setTree({ '/r': ['/r/newpkg'], '/r/newpkg': [] })
    f.fire('/r')

    expect(onChange).toHaveBeenCalledTimes(1)
    expect([...f.watched.keys()].sort()).toEqual(['/r', '/r/newpkg'])
  })

  it('包被删掉 → 它的监听收掉，不留悬空句柄', () => {
    const tree: Record<string, string[]> = { '/r': ['/r/old'], '/r/old': [] }
    const f = fakeFs(tree)
    watchTree(['/r'], () => {}, f.deps)
    f.setTree({ '/r': [] })
    f.fire('/r')
    expect(f.closed).toEqual(['/r/old'])
    expect([...f.watched.keys()]).toEqual(['/r'])
  })

  it('close() 收掉全部监听', () => {
    const f = fakeFs({ '/r': ['/r/a'], '/r/a': [] })
    const h = watchTree(['/r'], () => {}, f.deps)
    h.close()
    expect(f.closed.sort()).toEqual(['/r', '/r/a'])
    expect(f.watched.size).toBe(0)
  })
})
