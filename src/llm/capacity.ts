/**
 * 「这个模型能吃多长的 prompt」——**一个数字，一个方向：宁可报小，绝不报大。**
 *
 * 这个数字唯一的消费方是对话工作台那一端的**自动压缩**：DSH 的 compaction-basic 在
 * `thresholdRatio × contextWindow`（默认 0.8）处把老的对话段落summarize 掉。所以：
 *
 * - **报小了**：压缩来得早一点，少用一点上下文——只损失效率。
 * - **报大了 / 报不出来**：压缩永远不触发，一路涨到上游 400，**整轮对话当场死掉**。
 *
 * 两边代价差着一个量级，所以这里的每一条规则都朝"小"的方向倒：猜不到就用
 * {@link FALLBACK_CONTEXT_WINDOW} 这个保守下限，绝不乐观外推。**一个乐观的默认值会静默地
 * 把今天这个 bug 原样重造出来**——压缩照样不触发，只是错得更晚、更难查。
 *
 * 真相源是**成员自己的 `params.contextWindow`**（用户在源配置里填的那一格）。下面这张
 * {@link KNOWN_MODEL_CONTEXT} 只是免得每个人都得先去查一遍文档的便利默认，不是权威：
 * 它必然会随各家改版而过时，所以**只收录能确证的那几个**，拿不准的一律不进表——
 * 表里少一条只是回落到下限（安全），多一条错的会直接把这条防线变成摆设。
 */

/** 猜不到时用的保守下限。挑 32K 而不是更小：再小会让正常对话频繁压缩、可用性肉眼可见地掉。 */
export const FALLBACK_CONTEXT_WINDOW = 32_768

/**
 * 模型 id → 上下文窗口的便利默认表。**加一条之前先确证**（官方文档写着的数字），
 * 拿不准就别加——回落到 {@link FALLBACK_CONTEXT_WINDOW} 是安全的，加错不是。
 *
 * 匹配按 `id` 前缀（`deepseek-chat` 命中 `deepseek-chat-0324`），且先剥掉中转网关常见的
 * `<厂商>/` 前缀（Cloudflare AI Gateway 的 `deepseek/deepseek-chat` 就是这个形状）。
 */
export const KNOWN_MODEL_CONTEXT: Array<{ prefix: string; window: number }> = [
  { prefix: 'deepseek-v4-flash', window: 1_000_000 },
  { prefix: 'deepseek-chat', window: 65_536 },
  { prefix: 'deepseek-reasoner', window: 65_536 },
  { prefix: 'glm-4.5', window: 128_000 },
  { prefix: 'glm-4.6', window: 128_000 },
]

/** 剥掉中转网关加的 `<厂商>/` 前缀并小写化——`deepseek/DeepSeek-Chat` → `deepseek-chat`。 */
function normalizeModelId(model: string): string {
  const slash = model.lastIndexOf('/')
  return (slash === -1 ? model : model.slice(slash + 1)).trim().toLowerCase()
}

/** 查表：命中返回窗口，没命中返回 `undefined`（**不是**下限——"没查到"和"就是这么小"是两件事，
 *  合并了就没法在诊断里指出"这个成员在吃保守默认、去填一下"）。 */
export function knownModelContextWindow(model: string): number | undefined {
  const id = normalizeModelId(model)
  return KNOWN_MODEL_CONTEXT.find((e) => id.startsWith(e.prefix))?.window
}

/** 用户填的那一格。表单给的是字符串，所以 string / number 都收；非正整数一律当没填
 *  （`0`、负数、`"abc"` 都不是"无限"，把它们当成有效值会造出一个荒谬的阈值）。 */
export function declaredContextWindow(raw: unknown): number | undefined {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : undefined
}

/** 一个成员的最终窗口：**用户填的 > 查表 > 保守下限**。三档都有值，所以这个函数永不返回
 *  undefined——"报不出容量"正是今天这个 bug 的成因，不该在这一层被重新引入。 */
export function memberContextWindow(rawDeclared: unknown, model: string): number {
  return declaredContextWindow(rawDeclared) ?? knownModelContextWindow(model) ?? FALLBACK_CONTEXT_WINDOW
}


