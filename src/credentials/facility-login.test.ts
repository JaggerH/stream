import { describe, it, expect, vi } from 'vitest'
import { findLoginRecipe, loginToFacility, type FacilityLoginDeps } from './facility-login.ts'
import type { Recipe } from '../replay/recipe.ts'
import type { RecipeRunOutcome } from '../replay/recipe-runner.ts'

/** 一条最小的 browser 档 recipe；`login`/`facility` 由参数决定。 */
const rec = (facility: string, login: boolean): Recipe =>
  ({
    version: 1,
    kind: 'browser',
    sourceId: `${facility}-login`,
    cookieDomain: 'x.com',
    entryUrl: 'https://x.com/Login',
    loginCheck: { loggedIn: '.me', wall: '.wall' },
    session: { facility, lifecycle: 'one-shot', visibility: 'unattended' },
    steps: [],
    observers: [],
    output: { itemsAt: 'items', dedupeBy: 'g', targetCount: 1, mapping: { guid: 'g' } },
    meta: login ? { action: true, login: true } : {},
  }) as unknown as Recipe

const ok: RecipeRunOutcome = { outcome: 'ok', items: [], trace: [] }

const deps = (over: Partial<FacilityLoginDeps> & { recipes: () => ReadonlyMap<string, Recipe> }): FacilityLoginDeps => ({
  run: async () => ok,
  adoptCookies: async () => {},
  ...over,
})

describe('findLoginRecipe', () => {
  it('按 meta.login + session.facility 命中，返回全名和 recipe', () => {
    const table = new Map([
      ['@a/eastmoney-login', rec('eastmoney', true)],
      ['@a/eastmoney-harvest', rec('eastmoney', false)], // 同 facility，但不是登录入口
      ['@b/quark-login', rec('quark', true)],
    ])
    expect(findLoginRecipe(table, 'eastmoney')[0]).toBe('@a/eastmoney-login')
  })

  /** 没有登录 recipe 是**说得清的错**，不是"返回空让调用方自己想办法"。 */
  it('这个 facility 没有登录 recipe → 抛，并说清只能人工重登', () => {
    expect(() => findLoginRecipe(new Map([['@b/quark-login', rec('quark', true)]]), 'eastmoney'))
      .toThrow(/没有登录 recipe|人工/)
  })

  /**
   * 多条 → 抛。**绝不挑一个**：挑错了就是去登了另一个账号，而登录会踢掉同账号在别处的会话。
   * 这条是"判据要有名字"的另一半：名字能命中多个时，宁可停。
   */
  it('同一个 facility 有两条登录 recipe → 抛，并列出候选', () => {
    const table = new Map([
      ['@a/eastmoney-login', rec('eastmoney', true)],
      ['@b/eastmoney-login', rec('eastmoney', true)],
    ])
    expect(() => findLoginRecipe(table, 'eastmoney')).toThrow(/@a\/eastmoney-login.*@b\/eastmoney-login|拒绝猜/s)
  })
})

describe('loginToFacility', () => {
  /**
   * **这一条钉的是正确性，不是顺序洁癖。**
   *
   * 登录 recipe 跑完的那一刻，新 cookie 还只在**浏览器**里。不去取，调用方紧接着的那次重试
   * 就还在吃登录**之前**那一份，表现成"登录报成功、随后照样 302"，而两边看起来都正常。
   * 活体实测（2026-09-03）：任务 03:44:17 开始，cookie 文件 03:45:01 才落盘（扩展推过来的
   * 时刻），中间那次重试拿到的是旧的。把 `adoptCookies` 从实现里删掉，这条必须变红。
   */
  it('跑完登录 recipe 之后去取新 cookie', async () => {
    const order: string[] = []
    await loginToFacility(deps({
      recipes: () => new Map([['@a/eastmoney-login', rec('eastmoney', true)]]),
      run: async () => { order.push('run'); return ok },
      adoptCookies: async () => { order.push('adopt') },
    }), 'eastmoney')
    expect(order).toEqual(['run', 'adopt'])
  })

  it('参数袋是空的——账号密码由执行器自己从配置 row 注入，不经这里', async () => {
    const run = vi.fn<FacilityLoginDeps['run']>(async () => ok)
    await loginToFacility(deps({ recipes: () => new Map([['@a/x-login', rec('x', true)]]), run }), 'x')
    expect(run.mock.calls[0]![1]).toEqual({})
  })

  /**
   * 登录没成必须抛。返回一个分不清"登上了/没登上"的东西，调用方会当成登上了去重做那件事，
   * 而那件事可能是下一笔单。同时**不去取 cookie**——没登上就没有新 cookie 可取。
   */
  it.each(['needsLogin', 'blocked', 'unavailable'] as const)('登录 recipe 结果是 %s → 抛，且不取 cookie', async (outcome) => {
    const adoptCookies = vi.fn(async () => {})
    await expect(loginToFacility(deps({
      recipes: () => new Map([['@a/x-login', rec('x', true)]]),
      run: async () => ({ outcome, items: [], trace: [], reason: '验证码认了 5 次都没过' }),
      adoptCookies,
    }), 'x')).rejects.toThrow(/没跑成|验证码认了 5 次/)
    expect(adoptCookies).not.toHaveBeenCalled()
  })
})
