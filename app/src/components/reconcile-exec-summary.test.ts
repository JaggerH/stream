import { describe, expect, it } from 'vitest'
import { EXEC_ACTIONS, execConfirmSummary, type ExecCopy, type ExecutedKind } from './reconcile-exec-summary.ts'
import type { ReconcilePlanAction } from '../lib/types.ts'

/**
 * 这个 bug 的成因不是"漏了一个字段",是**没有任何东西会在漏的时候出声**：确认弹窗那句话
 * 手写了三个 counts 字段,后端加 `delete-redundant` 时它安安静静地继续说旧的三类。
 * 只补一个进去,下次再加一类照样漏。
 *
 * 所以护栏有两道,这个文件把两道都钉住：
 *  ① **编译期**——措辞表是 `Record<ExecutedKind, ExecCopy>`,键集从 `ReconcilePlanAction['kind']`
 *     减去 `pending` 派生。前端一旦认得某个新 kind（写进 types.ts 的镜像里）,没给它措辞就是
 *     `tsc` 报错。下面那条 `@ts-expect-error` 是这道护栏的**反证**：故意抽掉一项、断言它编译不过。
 *  ② **运行期**——后端比前端新的那半边（kind 还没进 types.ts）编译器看不见,认不出的 kind
 *     必须被数出来说成「另有 N 条」,绝不许静默漏掉。
 */
describe('reconcile-exec-summary — 新增一类动作不会再静默漏掉', () => {
  it('① 编译期：措辞表覆盖全部执行档动作,少一项就编译不过', () => {
    // 正向：每一类都有动词（`Record` 只保证键在,不保证 value 不是空壳）。
    for (const kind of Object.keys(EXEC_ACTIONS) as ExecutedKind[]) {
      expect(EXEC_ACTIONS[kind].verb).toBeTruthy()
    }

    // 反证：从表里抽掉一项就装不进 `Record<ExecutedKind, ExecCopy>`——这正是**新增一种动作类型
    // 却没给它措辞时 tsc 会撞上的那个错**。若哪天这一行不再报错（有人把表改成 Partial、或
    // 键集不再从 kind 派生）,`@ts-expect-error` 会反过来报 "Unused '@ts-expect-error' directive",
    // `npm run typecheck` 照样红——护栏塌了也有人喊。
    const { 'delete-redundant': _抽掉一项, ...少一项 } = EXEC_ACTIONS
    // @ts-expect-error 少了 'delete-redundant',不满足 Record<ExecutedKind, ExecCopy>
    const _证明: Record<ExecutedKind, ExecCopy> = 少一项
    expect(Object.keys(_证明)).toHaveLength(Object.keys(EXEC_ACTIONS).length - 1)
  })

  it('② 运行期：后端比前端新——认不出的 kind 也要数出来,不许静默漏掉', () => {
    const row = (kind: string, path: string, size: number) =>
      ({ kind, key: path, src: { path, name: path.split('/').pop()!, size } } as unknown as ReconcilePlanAction)

    const text = execConfirmSummary([
      row('move', '/quark/来源/01.甲.mp3', 1024),
      // 这一版前端根本没听说过的两种动作（后端先上了、types.ts 的镜像还没跟）。
      row('delete-brandnew', '/quark/来源/02.乙.mp3', 1024),
      row('archive-somewhere', '/quark/来源/03.丙.mp3', 1024),
    ])

    expect(text).toContain('移动 1 条')
    // 说不出名字可以,装作没有不行——那正是「删了 4 个却说删 0 个」的同一种谎。
    expect(text).toContain('另有 2 条')
    // 数不出体量的动作不许硬凑进释放空间那笔账（它们可能压根不删东西）。
    expect(text).not.toContain('预计释放')
  })

  /**
   * 整句原文钉在这里——**弹窗的正文就是这条测试的字面量**,谁改措辞都得先看见自己改了什么。
   * 同一个动词只说一次（「删除 1 条 A、1 条 B」而不是「删除 A、删除 B」）：三类删除各自
   * 带一遍动词,读起来像三件事,而用户要判断的是"这一轮一共删掉什么"。
   */
  it('五类全齐时的整句原文：同动词合并说一次', () => {
    const MiB = 1024 * 1024
    const row = (kind: string, n: string, size: number, extra: object = {}) =>
      ({ kind, key: n, src: { path: `/quark/来源/${n}`, name: n, size }, ...extra } as unknown as ReconcilePlanAction)

    expect(execConfirmSummary([
      row('move', '01.甲.mp3', MiB),
      row('delete-dup', '02.乙.mp3', 8 * MiB),
      row('delete-loser', '03.丙.mp3', 16 * MiB),
      row('delete-redundant', '04.丁.mp3', 32 * MiB),
      row('replace', '05.戊.mp3', 256 * MiB, {
        oldPath: '/quark/付费/05.戊.mp3',
        compare: { candidates: [{ path: '/quark/付费/05.戊.mp3', size: 64 * MiB, inLib: true }] },
      }),
    ])).toBe(
      '将移动 1 条，删除 1 条字节全等的重复、1 条同集落选副本、1 条免费集副本（源站自己放得出），'
      + '换掉 1 条库里的旧版本（删旧的、新的上位）。预计释放 120.0 MiB。',
    )
  })

  it('全部为 0（只有 pending 之类）→ 明说没有要执行的,不吐一串「0 条」', () => {
    expect(execConfirmSummary([])).toBe('这一轮没有要执行的动作。')
  })
})
