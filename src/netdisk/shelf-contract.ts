/**
 * **测试脚手架，不是生产代码**：本文件 import 了 vitest（`describe`/`it`/`expect`），只能被
 * `*.test.ts` 引用。生产代码里出现对它的 import = 把测试框架拖进运行时，绝不允许。
 */
import { describe, it, expect } from 'vitest'
import type { FileShelf } from './shelf.ts'
import { isObjectNotFound } from './alist-client.ts'

/**
 * 每个 `FileShelf` 实现都要跑的同一份用例（spec 2026-09-03 §3.5）。两份实现漂了，这里就是那个报警的人。
 * `seed` 把 `{ '/dir/a.mp3': size }` 灌进去。
 */
export function describeShelfContract(
  name: string,
  make: () => Promise<{ shelf: FileShelf; seed: (files: Record<string, number>) => Promise<void> }>,
): void {
  describe(`FileShelf 契约：${name}`, () => {
    it('搬完立即列：源里不在、目标里在（listingIsLive:false 的实现 refresh 后必须成立）', async () => {
      const { shelf, seed } = await make()
      await seed({ '/src/a.mp3': 1 })
      await shelf.mkdir('/dst')
      await shelf.move('/src', '/dst', ['a.mp3'])
      // 最后一份搬走后有的来源会连空目录一起收掉——那也算"源里不在"，不是失败。
      const src = await shelf
        .listDirRecursive('/src', 0, true)
        .catch((e: Error) => (isObjectNotFound(String(e.message)) ? [] : Promise.reject(e)))
      const dst = await shelf.listDirRecursive('/dst', 0, true)
      expect(src.map((f) => f.name)).not.toContain('a.mp3')
      expect(dst.map((f) => f.name)).toContain('a.mp3')
    })

    it('mkdir 幂等', async () => {
      const { shelf } = await make()
      await shelf.mkdir('/d')
      await expect(shelf.mkdir('/d')).resolves.toBeUndefined()
    })

    // 这条是上一条的正面对照，**不能省**：下一条只要求"删不存在的名字别抛别的错"，一个**根本不发请求**
    // 的实现照样能过它。删一个真在的名字、再列一遍确认它没了——这才验到"删真的删了"。
    it('删一个真在的名字：列出来就没了', async () => {
      const { shelf, seed } = await make()
      await seed({ '/g/keep.mp3': 1, '/g/gone.mp3': 2 })
      await shelf.remove('/g', ['gone.mp3'])
      const left = (await shelf.listDirRecursive('/g', 0, true)).map((f) => f.name)
      expect(left).not.toContain('gone.mp3')
      expect(left).toContain('keep.mp3') // 别把整个目录端了
    })

    // 活体实测（2026-09-03，OpenList 的夸克挂载）：`POST /api/fs/remove` 拿一个**不存在的名字**照样答
    // `{"code":200,"message":"success","data":null}`——**删不存在的东西是静默成功的**。所以契约只能要求
    // "别抛别的错"，不能要求它抛。这正是执行器必须在每次删之前自己核一遍存在性/大小的原因（Task 4）：
    // 网盘不会替你喊，靠删的返回值判"这份还在不在"永远是绿的。
    it('删一个不存在的名字：要么静默成功、要么抛能被 isObjectNotFound 认出的错——绝不抛别的', async () => {
      const { shelf, seed } = await make()
      await seed({ '/d/x.mp3': 1 })
      const err = await shelf.remove('/d', ['nope.mp3']).then(
        () => null,
        (e: Error) => e,
      )
      if (err) expect(isObjectNotFound(err.message), `抛了别的错：${err.message}`).toBe(true)
    })

    // 注意：下面 seed 的键是 NFD（e + U+0301），断言里是 NFC（U+00E9）。两者肉眼一模一样——
    // 编辑这一段时别让工具把它"顺手归一化"，那会让这条用例静默失去牙齿。
    it('递归列的 name 是相对根的子路径，/ 分隔，NFC', async () => {
      const { shelf, seed } = await make()
      await seed({ '/r/sub/é.mp3': 1 }) // 键用 NFD 写（e + 组合重音），列出来必须是 NFC
      const out = await shelf.listDirRecursive('/r', 5, true)
      expect(out.map((f) => f.name)).toEqual(['sub/é.mp3'])
    })

    it('caseSensitive:false 的实现：A.mp3 与 a.mp3 是同一个名字', async () => {
      const { shelf, seed } = await make()
      if (shelf.traits.caseSensitive) return
      await seed({ '/c/A.mp3': 1 })
      await expect(shelf.remove('/c', ['a.mp3'])).resolves.toBeUndefined()
      expect(await shelf.listDirRecursive('/c', 0, true)).toEqual([])
    })
  })
}
