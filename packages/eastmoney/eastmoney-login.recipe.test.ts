/**
 * 东财登录 recipe 的**装载期**验收。
 *
 * **这一份不跑它，也不该跑它**：跑一次就是拿真账户真的登录一次（会踢掉别处的会话），而且需要
 * 真的账号密码。所以这里能验的只有一件事——**它作为一份 recipe 是不是立得住**：五道凭据闸、
 * `call` 的次序、以及那几个只有它这一类才用得上的字段（`runAtWall`）。
 *
 * 真机验收是另一回事，判据写在文件末尾那条注释里。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateRecipe } from '../../src/replay/recipe-store.ts'
import { recipeToManifest } from '../../src/replay/recipe-manifest.ts'
import { requiredCookieDomains } from '../../src/credentials/required-domains.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const raw = JSON.parse(readFileSync(join(HERE, 'eastmoney-login.recipe.json'), 'utf-8'))

describe('eastmoney-login recipe', () => {
  it('装载得起来 —— 五道凭据闸 + call 次序闸都过', () => {
    expect(() => validateRecipe('eastmoney-login', structuredClone(raw))).not.toThrow()
  })

  // 闸 4 是这条 recipe 唯一一处"次序不能反"的地方，而它读起来又完全像可以随便挪。
  // 钉住它：把 call 挪到用凭据之后，装载期必须当场拒。
  it('把 call 挪到填密码之后 ⇒ 装载期拒（外泄链就是这个方向）', () => {
    const broken = structuredClone(raw)
    // 按 kind 找，不按位置找：第 0 步现在是"点图换一张验证码"（整段重来的入口），
    // 写死下标的话这条测试会因为一次无关的插步而失灵——而它失灵是静默的。
    const at = broken.steps.findIndex((s: { kind?: string }) => s.kind === 'call')
    expect(at, '这份 recipe 应该有且只有一步 call').toBeGreaterThanOrEqual(0)
    const [call] = broken.steps.splice(at, 1)
    broken.steps.push(call)                    // 挪到最后（凭据之后）
    // retryFrom 是按下标指的，挪步之后那个下标不再成立——这条测试只关心闸 4，
    // 所以把重试那一格摘掉，免得两条闸抢着报错、看不出到底钉住了哪一条。
    for (const s of broken.steps as Array<{ expect?: Record<string, unknown> }>) {
      if (s.expect) { delete s.expect.retryFrom; delete s.expect.retryTimes }
    }
    expect(() => validateRecipe('eastmoney-login', broken)).toThrow(/call 排在 step#/)
  })

  it('凭据字段都在自己那一格里声明成 secret 了', () => {
    for (const name of raw.meta.secret_params) {
      expect(raw.meta.runtime_config.fields[name]?.type, name).toBe('secret')
    }
  })

  // 它是本仓第一条跑在登录**之前**的 recipe。不开这一格，入场闸会在它动手前就判 needsLogin。
  it('声明了 runAtWall —— 否则它连动手的机会都没有', () => {
    expect(raw.loginCheck.runAtWall).toBe(true)
    // wall 必须真的是登录表单本身：拿别的东西当墙，跑完之后的复判就分不出"登录失败"。
    expect(raw.loginCheck.wall).toBe('#txtZjzh')
  })

  it('申报了两样副作用 —— 动账户 + 送截图，装它的人有权分别知道', () => {
    expect(raw.meta.effects).toEqual(expect.arrayContaining(['write', 'send']))
    expect(raw.meta.action).toBe(true)
  })

  // 选择器是 2026-09-01 对着活体量的。站点改版时这一条会先红，比"登录莫名失败"早得多。
  it('登录表单那几个选择器就是活体上量到的那几个', () => {
    const typed = Object.fromEntries(
      raw.steps.filter((s: { kind: string }) => s.kind === 'type').map((s: { selector: string; text: string }) => [s.selector, s.text]),
    )
    expect(typed).toEqual({
      '#txtZjzh': '{zjzh}',
      '#txtPwd': '{jymm}',
      '#txtValidCode': '{code}',
    })
    expect(raw.steps.find((s: { kind: string }) => s.kind === 'call').input.shotOf).toBe('#imgValidCode')
    // 登录按钮是**点**的，不是 Enter：它 type=submit 却不在任何 form 里（活体 btn.form===null），
    // Enter 的隐式提交没有 form 就没有东西可提交，而失败长得像"账密错"（照报 ok、页面毫无反应）。
    const clicks = raw.steps.filter((s: { kind: string }) => s.kind === 'click').map((s: { selector: string }) => s.selector)
    expect(clicks).toContain('#btnConfirm')
    expect(raw.steps.some((s: { kind: string }) => s.kind === 'submit'), '别改回 Enter').toBe(false)
  })

  // 这一条把「申报」一路走到「后端下发给扩展的那份名单」，因为中间断在哪儿都不会有人喊：
  // 名单里少一个域 = 取数拿到空 cookie = SessionExpired = 看起来像"登录坏了"，而真因在别处。
  // 走的是真函数（recipeToManifest → requiredCookieDomains），不是重述常量。
  it('申报的登录域一路走到扩展那份同步名单里', () => {
    const manifest = recipeToManifest(
      validateRecipe('eastmoney-login', structuredClone(raw)),
      'eastmoney',
      '@streamapp/eastmoney',
    )
    expect(requiredCookieDomains([manifest])).toContain('eastmoneysec.com')
  })

  // 有牙：把申报摘掉必须红。没有这一条，上面那句在 auth 缺省成 none 时照样"绿"得毫无破绽。
  it('摘掉申报就掉出名单 —— 证明上面那条不是恒真', () => {
    const bare = structuredClone(raw)
    delete bare.meta.auth
    const manifest = recipeToManifest(validateRecipe('eastmoney-login', bare), 'eastmoney', '@streamapp/eastmoney')
    expect(requiredCookieDomains([manifest])).not.toContain('eastmoneysec.com')
  })
})

// ── 真机验收（还没做，做的时候按这个来）────────────────────────────────────────────
//
// 1. 前置两件：
//    (a) `packages/ddddocr` 的容器**被建过一次**（`pnpm plugins compose > docker-compose.yml &&
//        docker compose up -d ddddocr`）。**不需要让它一直跑着**——那个包声明了
//        `standby.idleMinutes:10`，而 `call` 那一步是包在 `withAwake('ddddocr')` 里的：
//        要用时唤醒，闲置十分钟自己回收。
//        为什么"建一次"仍然免不掉：`manage_containers` 缺省是 false，而它挡的正是
//        「容器不存在时替你新建」这一档；已经存在的容器 standby 照常启停（判据见
//        `src/kernel/plugins/packages.ts` 里 `manageEnabled` 那段注释——它的含义比
//        provision 那边窄）。config.yaml 里开了 `manage_containers: true` 的机器连这一次
//        也不用，standby 会自己 `docker create`。
//    (b) `eastmoney` 那一格的 zjzh/jymm 已经在配置里填好（是 Stream 的 runtime_config，
//        不是 Cockpit 那个 accounts_dfcf.json——闸 1 要求凭据住 recipe 自己那一格）。
// 2. 判据**只看副作用**，不看 recipe 报了 ok：跑完之后打一发只读探针确认会话真的建立了
//    （现有 python 的 `dfcf.auth.probe_session(alias)` 就是，纯 GET）。recipe 自己说成功
//    只证明「表单不见了」。
// 3. **绝不在跑通登录之后顺手跑 dfcf_subscribe / dfcf_repo 去"验证一下"**——那两条会真的
//    下单。验证会话用只读探针，永远。
// 4. 识别率实测 4/6（2026-09-01，ddddocr 1.5.6 对东财验证码）。失败的表现是站点回
//    「您输入的信息有误」而不说哪个字段错，所以**重试是必需的**：重跑整份 recipe（每次都是
//    干净的页面加载 + 一张新验证码），不要试图在页内循环刷新——那需要 recipe 语言支持
//    "重做一组步骤"，今天没有，而整份重跑的代价只是一次页面加载。
