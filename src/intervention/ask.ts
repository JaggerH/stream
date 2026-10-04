import type { ChatMessage } from '../llm/client.ts'
import { usageOf } from '../llm/client.ts'
import { extractJson } from '../llm/extract-json.ts'
import { chatViaLlm, type LlmForTask } from '../llm/task.ts'
import type { Feature, StateDef, StateId } from '../replay/state-graph.ts'
import type { Scene } from '../replay/scene.ts'

/** 这次介入要问的那一个问题（spec §4.1）。一次只问一个——三种问题的答案形状不同，合并问会让解析没法严格。 */
export interface AskInput {
  kind: 'state' | 'discriminator' | 'transition' | 'irreversible'
  sourceId: string
  /** 这次现场在哪条路线上——**它决定哪几种特征合法**（见 `ALLOWED_FEATURE_KINDS`）。 */
  side: Side
  /** 设施键：状态 id 的前缀由它定（`<facility>/<状态名>`），状态图与观测账本也按它分文件。 */
  facility: string
  scene?: Scene
  known: StateDef[]
  candidates?: StateId[]
  from?: StateId
  goal?: StateId
  reason: string
}

export type Side = 'browser' | 'desktop'

/**
 * **每条路线只判得了自己那几种特征。** 浏览器侧的 `DomPerception` 只求值 url / dom，
 * 碰到别的直接抛（`state-perception-dom.ts`：「网页这条路线判不了 X 特征」）；桌面侧同理只认
 * a11y / text / image。
 *
 * 为什么必须是一份**具名**名单而不是散在提示词里的一句话：一条 `text` 特征被收进浏览器侧的
 * 状态图之后，那个 facility 此后**每一趟** identify 都会抛，而 `classifyByState` 把它 catch 成
 * 一行「状态诊断失败」——引擎从此认不出任何状态，日志里却只有这一行。活体 2026-09-11 的
 * xhs-search 上模型就提了这么一条。名单有名字，闸（`gate.ts` / Broker）才能复用同一个判据。
 */
export const ALLOWED_FEATURE_KINDS: Record<Side, readonly Feature['kind'][]> = {
  browser: ['url', 'dom'],
  desktop: ['a11y', 'text', 'image'],
}

const SIDE_LABEL: Record<Side, string> = { browser: '浏览器', desktop: '桌面' }

/** 这条路线判不判得了这种特征。判据有名字，才有地方挂测试、才有第二个消费方能复用。 */
export function featureKindAllowed(side: Side, kind: Feature['kind']): boolean {
  return ALLOWED_FEATURE_KINDS[side].includes(kind)
}

/** 这条路线上「不合法的特征」怎么说给人听——解析和闸两处共用一句，免得两处说法分家。 */
export function illegalKindWhy(side: Side, kind: string): string {
  return `${SIDE_LABEL[side]}这条路线判不了 ${kind} 特征（只认 ${ALLOWED_FEATURE_KINDS[side].join(' / ')}）`
}

/** 模型可能给出的合法答案。`unrepairable` 是**结论**不是失败——它和解析不了是两件事。 */
export type AskAnswer =
  | { kind: 'state'; stateId: string; features: Feature[]; rationale: string; notes?: string[] }
  | { kind: 'discriminator'; features: Feature[]; rationale: string }
  | { kind: 'transition'; target: unknown; action: 'click' | 'type' | 'scroll'; rationale: string }
  | { kind: 'irreversible'; refs: number[]; rationale: string }
  | { kind: 'unrepairable'; rationale: string }

const GRAMMAR_LINE: Record<Feature['kind'], string> = {
  url: `- {"kind":"url","pattern":"https://host/path*"}      // * 通配整串`,
  dom: `- {"kind":"dom","selector":"<css selector>","absent":false}`,
  a11y: `- {"kind":"a11y","query":{...},"absent":false}      // 桌面 a11y 查询`,
  text: `- {"kind":"text","text":"屏上的一串字","absent":false}`,
  image: `- {"kind":"image","png":"<base64>","absent":false}   // 仅当你手里有参考图；一般不用`,
}

/**
 * 语法表**按路线裁**：只把这一侧判得了的那几种摆出来。整张五档都端上去的话，模型会挑一条
 * 这一侧根本求值不了的（活体上它就挑了 `text`），而那条一旦进图就是整个 facility 的 identify
 * 全哑——与其事后拒，不如一开始就别给。
 */
function systemPrompt(side: Side): string {
  const kinds = ALLOWED_FEATURE_KINDS[side]
  return `你在帮一个确定性的界面自动化引擎补状态图。引擎认不出当前界面了，你只回答被问的那一个问题，
输出**只能是一个 JSON 对象**（可以包在 \`\`\`json 代码块里），不要任何别的文字。
当前现场是**${SIDE_LABEL[side]}**这条路线，特征（Feature）**只能**是下面这几种，别的一律不收：
${kinds.map((k) => GRAMMAR_LINE[k]).join('\n')}
"absent":true 表示「它不在」也是判据。
判据要**便宜且可重放**：不要背景色，不要坐标。
如果你判断这个问题在当前界面上答不了（要登录、站点改版到面目全非、问题本身不成立），回：
{"unrepairable":true,"rationale":"为什么"}`
}

function knownText(known: StateDef[]): string {
  if (!known.length) return '（状态图里还没有任何状态）'
  return known
    .map((s) => `- ${s.id}${s.group ? `（组 ${s.group}）` : ''}: ${JSON.stringify(s.features)}${s.note ? ` // ${s.note}` : ''}`)
    .join('\n')
}

function sceneText(scene: Scene | undefined): string {
  // 现场抓不到也要如实说，别拼一段看起来正常的空白——模型会当成「页面上什么都没有」去推理。
  if (!scene) return '（引擎没能抓到现场）'
  const els = scene.elements
    .slice(0, 120)
    .map((e) =>
      `${e.n !== undefined ? `#${e.n} ` : ''}${e.tag ?? e.kind ?? ''} ${e.role ? `[${e.role}] ` : ''}${e.name ?? ''} @(${e.rect.x},${e.rect.y},${e.rect.w}x${e.rect.h})`.trim(),
    )
  return [
    scene.url ? `url: ${scene.url}` : '',
    scene.title ? `title: ${scene.title}` : '',
    scene.text ? `可见文字（开头）:\n${scene.text}` : '',
    `可交互元素（${scene.elements.length}${scene.truncated ? '+，已截断' : ''}）:\n${els.join('\n') || '（无）'}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

function question(input: AskInput): string {
  switch (input.kind) {
    case 'state':
      // 前缀**点名给到字面量**，不写成 `<包>` 这种占位：活体上模型照着占位填了 sourceId
      // （`xhs-search/search`），而入库那一关按 facility 校验，整条提议直接 400。
      return `问题：这是哪个界面？给一组能**只**认出它、且在别的界面上不成立的特征。
回 {"stateId":"${input.facility}/<状态名>","features":[...],"rationale":"一句话"}——stateId 的前缀**必须**是 \`${input.facility}\`，不是来源名。
如果它就是某个已知状态、只是特征漂了，stateId 用那个已知的名字。`
    case 'discriminator':
      return `问题：下面这几个状态同时命中了：${(input.candidates ?? []).join('、')}。给**一条**在当前界面成立、且能把它们分开的特征。
回 {"features":[<一条>],"rationale":"一句话"}`
    case 'transition':
      return `问题：现在在 ${input.from}，要去 ${input.goal}，状态图里没有路。下一步该对哪个元素做什么？
回 {"target":{"selector":"<css>"} 或 {"name":"<元素名>"},"action":"click|type|scroll","rationale":"一句话"}`
    case 'irreversible':
      return [
        '这是**探索建图**前的安全筛查：接下来会有程序自动点这一屏上的可点元素、看它们通向哪里。',
        '请指出**点下去会产生收不回的后果**的编号：发出消息 / 评论 / 发布、下单 / 付款、删除 / 清空、关注 / 拉黑、退出登录、切换账号、修改设置。',
        '只看后果，不看危险的字眼；没有文字的图标按位置和上下文判断；拿不准的算收不回。',
        '回答只能是 {"refs":[编号,…],"rationale":"一句话"}，refs 可以是空数组。',
      ].join('\n')
  }
}

/** 组一次问话：system 固定（词汇表 + 输出纪律），user 里是这次的现场与问题；有截图就多一个 image 分片。 */
export function buildMessages(input: AskInput): ChatMessage[] {
  const text = [
    `来源：${input.sourceId}`,
    `触发原因：${input.reason}`,
    `已知状态：\n${knownText(input.known)}`,
    `现场：\n${sceneText(input.scene)}`,
    question(input),
  ].join('\n\n')
  const shot = input.scene?.shot
  const content: ChatMessage['content'] = shot
    ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: `data:${shot.mime};base64,${shot.base64}` } }]
    : text
  return [{ role: 'system', content: systemPrompt(input.side) }, { role: 'user', content }]
}

const FEATURE_KINDS = new Set(['url', 'dom', 'a11y', 'text', 'image'])

/**
 * 是不是**我们这套词汇**里的一条特征（判据有名字，才有地方挂测试）。
 * 五档与 `state-graph.ts` 的 `Feature` 一一对应——只认 kind 不看载荷的话，`{"kind":"dom"}`
 * 这种没有 selector 的空壳会一路进到状态图里，直到运行时才炸。
 */
function isFeature(x: unknown): x is Feature {
  if (!x || typeof x !== 'object') return false
  const f = x as Record<string, unknown>
  if (!FEATURE_KINDS.has(String(f.kind))) return false
  switch (f.kind) {
    case 'url':
      return typeof f.pattern === 'string' && f.pattern.length > 0
    case 'dom':
      return typeof f.selector === 'string' && f.selector.length > 0
    case 'a11y':
      // 数组也是 object：不排掉的话 `["按钮"]` 会被当成一条合法的 a11y 查询收下，
      // 而下游按 `{role,name}` 读它只会读到 undefined——一条永远匹配不上的特征，且不报错。
      return !!f.query && typeof f.query === 'object' && !Array.isArray(f.query)
    case 'text':
      return typeof f.text === 'string' && f.text.length > 0
    case 'image':
      return typeof f.png === 'string' && f.png.length > 0
    default:
      return false
  }
}

/**
 * 严格解析：**拒得要说清为什么**。这条路上「模型答歪了」是常态，一个含糊的失败会让人
 * 在轨迹里看到一条空提议却不知道模型到底说了什么。
 * JSON 抽取复用 `src/llm/extract-json.ts`（围栏/裸 JSON/前后带话都认），别在这里写第二套。
 */
export function parseAnswer(
  kind: AskInput['kind'],
  content: string | null,
  ctx: { side: Side; facility: string },
): { ok: true; answer: AskAnswer } | { ok: false; why: string } {
  if (!content) return { ok: false, why: '模型没有返回文本' }
  // extractJson 只取第一个 `[` 或 `{`：无围栏输出里若 `{...}` 前面出现了 `[1]` 这类东西，
  // 会被抢先解析成数组、然后在下面被判「不是一个 JSON 对象」。复用它是为了不在这里另养
  // 一套解析容错方言（那才是真正的隐患），这一点抢先解析是要接受的代价。
  const parsed = extractJson<unknown>(content)
  // 数组也算不合形状：答案约定是一个对象，收到数组说明模型答的是别的问题。
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, why: `不是一个 JSON 对象：${content.slice(0, 120)}` }
  }
  const j = parsed as Record<string, unknown>
  const rationale = typeof j.rationale === 'string' ? j.rationale : ''
  if (j.unrepairable === true) return { ok: true, answer: { kind: 'unrepairable', rationale: rationale || '（模型没给理由）' } }
  if (kind === 'irreversible') {
    const refs = j.refs
    if (!Array.isArray(refs) || !refs.every((r) => typeof r === 'number' && Number.isInteger(r) && r >= 0)) {
      return { ok: false, why: `refs 必须是非负整数数组：${JSON.stringify(refs)}` }
    }
    return { ok: true, answer: { kind: 'irreversible', refs: [...new Set(refs as number[])], rationale } }
  }
  if (kind === 'transition') {
    const action = j.action
    if (!j.target || typeof j.target !== 'object') return { ok: false, why: 'transition 缺 target' }
    if (action !== 'click' && action !== 'type' && action !== 'scroll') return { ok: false, why: `不认识的 action：${String(action)}` }
    return { ok: true, answer: { kind: 'transition', target: j.target, action, rationale } }
  }
  const feats = Array.isArray(j.features) ? j.features : []
  // 空 features 必须拒：空数组在 `validateStateGraph` 里是非法的（它匹配一切，等于把 identify 关掉）。
  if (!feats.length) return { ok: false, why: 'features 为空' }
  const bad = feats.filter((f) => !isFeature(f))
  if (bad.length) return { ok: false, why: `features 里有不合词汇的项：${JSON.stringify(bad[0])}` }
  // 词汇对了还不够：**这一侧判不判得了**是另一道题。一条这一侧求值不了的特征进了图，
  // 代价不是这次没提议，而是那个 facility 此后每一趟 identify 都抛（见 ALLOWED_FEATURE_KINDS 头注）。
  const illegal = (feats as Feature[]).find((f) => !featureKindAllowed(ctx.side, f.kind))
  if (illegal) return { ok: false, why: illegalKindWhy(ctx.side, illegal.kind) }
  if (kind === 'state') {
    if (typeof j.stateId !== 'string' || !j.stateId.includes('/')) return { ok: false, why: 'stateId 缺失或不是 <包>/<状态> 形状' }
    // 前缀不对**不拒，改名**：模型答的是「这是哪个界面」，前缀只是命名约定，为一个名字
    // 丢掉一次真正的判断（还白烧一次 token）不划算。改了就如实说，人接受时还能再改。
    const notes: string[] = []
    let stateId = j.stateId
    if (!stateId.startsWith(`${ctx.facility}/`)) {
      const leaf = stateId.slice(stateId.lastIndexOf('/') + 1)
      const fixed = `${ctx.facility}/${leaf}`
      notes.push(`stateId 前缀按 facility 改写：${stateId} → ${fixed}`)
      stateId = fixed
    }
    return {
      ok: true,
      answer: { kind: 'state', stateId, features: feats as Feature[], rationale, ...(notes.length ? { notes } : {}) },
    }
  }
  return { ok: true, answer: { kind: 'discriminator', features: feats as Feature[], rationale } }
}

/**
 * 一次调用：组消息 → `intervention.ask` 调用点 → 严格解析。
 *
 * 梯子没人答时 `chatViaLlm` 会抛 `LadderError`，这里**原样往上抛**：未配置 / 全失败 / 欠费
 * 是三种不同的红，分类是 Broker 的事，在这里吞掉就只剩「没答案」一种表现。
 * usage 缺席如实回 `reported:false`，**不补 0**——一个看着精确其实是猜的数字比没有更坏。
 */
export async function askOnce(
  llm: LlmForTask,
  input: AskInput,
): Promise<{
  answer: ReturnType<typeof parseAnswer>
  usage: { promptTokens: number; completionTokens: number; reported: boolean }
  wallMs: number
}> {
  const t0 = Date.now()
  const result = await chatViaLlm(llm, { messages: buildMessages(input), temperature: 0 }, 'intervention.ask')
  const u = usageOf(result.raw)
  return {
    answer: parseAnswer(input.kind, result.content, { side: input.side, facility: input.facility }),
    usage: u ? { ...u, reported: true } : { promptTokens: 0, completionTokens: 0, reported: false },
    wallMs: Date.now() - t0,
  }
}
