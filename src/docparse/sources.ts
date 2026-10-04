import type { BuiltinFn } from '../adapters/builtin/adapter.ts'
import { chatCompletion, type ChatMessage } from '../llm/client.ts'

/** parse Provider 的 invoke 输入：一份已经取回来的字节（item 的图片，或抓回来的 PDF）。
 *  「怎么从 item 找到它」不在这里——那是 `docparse/media.ts` 的 `resolveSourceBytes`。 */
export interface OcrInput {
  bytes: Uint8Array
  mime: string
}

const asInput = (i: unknown): OcrInput => i as OcrInput

/** 成员产出的统一合同：一段 markdown。**取最窄的有用公共形状**——视觉模型只会吐文本，
 *  MinerU 本来就产 markdown，两者能在这一个字段下拉平。版式结构（页/块/坐标）不进合同：
 *  今天没有任何消费方，塞进来只会逼视觉模型编造它拿不出的东西。 */
export interface OcrResult {
  markdown: string
}

/** 给视觉模型的指令。要求它**先做版面理解、按主次提取**，再照抄主体文字——这是 OCR 和
 *  "看图说话"的分界线，不说清楚，模型会开始总结画面内容，那对可检索文本毫无用处。
 *
 *  2026-08-06 从「原样转写全部文字」升级为「按视觉区域提取」：实测（抖音收藏页/手绘笔记截图）
 *  纯转写会把状态栏、导航/按钮、评论区、App 界面元素等次要文字平铺进结果，正文反而被淹没。
 *  升级后模型先区分主体（标题/正文/列表/表格/数据/笔记）与装饰（水印/角标/状态栏/导航/评论区/
 *  UI 元素/弹幕），只输出主体、按区域组织。仍保留「只输出图上真实存在的文字」——过滤的是装饰，
 *  不是允许它编造。 */
const OCR_INSTRUCTION =
  '把这张图片里的文字转成 Markdown。先理解版面结构：区分主体内容（标题、正文、列表、表格、' +
  '数据、笔记）与次要/装饰内容（水印、角标、状态栏时间电量、导航/按钮文字、评论区、App 界面元素、' +
  '无关注释、弹幕）。只输出主体内容，忽略所有次要/装饰文字。按视觉区域和阅读顺序组织输出，' +
  '保留标题层级、列表和表格结构。只输出图片上真实存在的文字，不要描述画面、不要补充解释、' +
  '不要翻译。看不清的地方留空，不要猜。'

/** 视觉大模型 OCR 成员（BYOK）。传输层与文本 LLM 完全相同：同一个 `/chat/completions`、
 *  同一把钥匙，只是消息正文里多一个 `image_url` 分片（`data:` URI，不必先把图片传到公网）。
 *  所以这里没有第二套协议，只有一个"把字节包成分片"的适配。
 *
 *  端点/模型/钥匙齐不了就 decline（[]），executor 落到下一个成员——和 llm-openai、
 *  OpenAI 兼容转写成员同一条纪律。 */
export function makeOcrVlmFn(deps: { token: (name: string) => string | null }): BuiltinFn {
  return async (input, params) => {
    const { bytes, mime } = asInput(input)
    const p = params as { baseUrl?: string; model?: string; tokenName?: string }
    if (!p.baseUrl || !p.model) return [] // decline — 成员没带齐端点/模型
    const apiKey = deps.token(String(p.tokenName ?? ''))
    if (!apiKey) return [] // decline — BYOK key 缺席
    if (!bytes?.byteLength) return [] // decline — 没有可读的字节

    const dataUri = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
    const messages: ChatMessage[] = [{
      role: 'user',
      content: [
        { type: 'text', text: OCR_INSTRUCTION },
        { type: 'image_url', image_url: { url: dataUri } },
      ],
    }]
    const res = await chatCompletion(messages, { baseUrl: p.baseUrl, apiKey, model: p.model })
    const markdown = res.content?.trim()
    // 空正文 = **发起了调用却没拿到东西**，这和上面几处 decline 不是一回事，所以不能也返回 []。
    //
    // 判据：`[]` 只留给**真弃权**（没配、不归我管，压根没发生尝试）；试过而没成就 **throw**。
    // executor 把抛出的错记进 `misses`（带 member + reason）并继续回落下一个成员——所以抛错
    // 既不挡兜底，又留下了理由。而干净的 `[]` 在 misses 里是**不可见的**：活体上就是这样，
    // 梯子静静落到兜底、兜底也失败，最后只剩一句"没有成员产出结果"，没人说得出为什么。
    // 带上 mime 和字节数：空正文最常见的原因是图片格式/体积，而那两个数就在手边。
    if (!markdown) {
      throw new Error(
        `视觉模型返回空正文（model=${p.model}, mime=${mime}, ${bytes.byteLength} bytes）——` +
          '图上无文字、或该模型读不了这个格式',
      )
    }
    return [{ markdown } satisfies OcrResult]
  }
}

/** 本地 MinerU 成员（兜底）。它自己就是一条 deterministic-first 管线（born-digital PDF 直接读
 *  文字层，只有图片区域才过视觉模型），所以它对**扫描件/长 PDF**仍有视觉模型给不了的确定性。
 *  错误照常抛：后端没配/挂了是真失败，不该伪装成空结果被当作"这一档跑过了"。 */
export function makeOcrMineruFn(client: {
  parse: (bytes: Uint8Array, mime: string, itemId?: string, signal?: AbortSignal) => Promise<{ markdown: string }>
}): BuiltinFn {
  return async (input) => {
    const { bytes, mime } = asInput(input)
    const res = await client.parse(bytes, mime)
    return [{ markdown: res.markdown } satisfies OcrResult]
  }
}
