/**
 * 文本指纹：**内容身份的唯一判据**。
 *
 * 一段文本 → 一把定长的"草图"（sketch）。两段文本的草图重合度 ≈ 它们的 Jaccard 相似度，
 * 而草图只有几十个数，可以存进库、可以两两比、不用留原文。
 *
 * **为什么身份必须落在文本上**：同一条内容被重新投放时，标题会被改写、封面会换、时长会因
 * 转码/剪片头差几秒、链接必然不同——**只有内容本身不变**。文字类内容的正文本来就在，
 * 音视频的"正文"就是它说出来的话（转写）。所以文本是唯一一个"改不掉又拿得到"的东西。
 *
 * 用字符 n-gram 而不是分词：中文没有空格，分词要引词典还会因分词器版本漂移；n-gram 对
 * 中英混排一视同仁，且对少量增删（片头问候语、平台加的水印文案）天然稳健。
 */

/** n-gram 的长度。5 个字对中文足够有区分度，对英文约等于一个词。 */
const GRAM = 5

/** 草图取多少个哈希。64 个的 Jaccard 估计误差约 ±0.06，足够分辨"同一条"和"不同条"。 */
const SKETCH_SIZE = 64

/**
 * 比之前的归一化：去掉一切不承载内容的东西。
 *
 * 转写文本尤其需要——同一段话被两个引擎转出来，标点、空格、大小写几乎必然不同，
 * 但**字**是一样的。
 */
export function normalizeForFingerprint(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
}

/** FNV-1a 32 位。要的是分布均匀且便宜，不是密码学强度。 */
function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * 文本 → 草图（升序的 K 个最小哈希）。
 *
 * 取"最小的 K 个"而不是随机 K 个，是 MinHash 的核心：两段文本的最小哈希集合重合多少，
 * 无偏地估计它们的 Jaccard——**两边各自独立算，不用同时在场**。这正是我们要的：
 * 每条 item 入库时各算各的，比对时只比草图。
 *
 * 文本太短（不足一个 n-gram）→ 空草图 = **不可判**，绝不是"和谁都像"。
 */
export function textSketch(text: string, gram = GRAM, size = SKETCH_SIZE): number[] {
  const s = normalizeForFingerprint(text)
  if (s.length < gram) return []
  const seen = new Set<number>()
  for (let i = 0; i + gram <= s.length; i++) seen.add(hash32(s.slice(i, i + gram)))
  return [...seen].sort((a, b) => a - b).slice(0, size)
}

/**
 * 两把草图的相似度（Jaccard 估计），0–1。
 *
 * **任一边为空 → 返回 -1，表示"判不了"**，不是 0。0 的意思是"看过了，不像"；
 * 判不了的意思是"还没有依据"——两者对下一步的处置完全相反（前者是结论，后者该去取文本）。
 */
export function sketchSim(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return -1
  // 两边都是升序的最小哈希集，直接归并数交集。
  let i = 0
  let j = 0
  let inter = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      inter++
      i++
      j++
    } else if (a[i] < b[j]) i++
    else j++
  }
  const union = a.length + b.length - inter
  return union === 0 ? -1 : inter / union
}

/**
 * **两段文本里最长的那一段一模一样的连续正文**（近似最长公共子串），单位是字。
 *
 * ## 为什么需要第二把尺，而不是把草图阈值调低
 *
 * 草图量的是 Jaccard——**它按整篇算**，而网页正文抽出来必然拖着一身样板：导航、推荐位、
 * 免责声明、股吧滚动条。同一条通稿挂在两个站上，实测 Jaccard 只有 **0.076–0.14**
 * （东方财富 × 新浪，两边一字不差地转了同一篇财联社稿）；而「各写各的同一件事」是
 * 0.006–0.016。**两者只差一个量级但都贴着 0**，中间没有能安全下刀的地方——为了并上前者
 * 把阈值压到 0.05，等于把后者也一起并了。
 *
 * 换成「最长连续共享块」，同一批数据就分得开了。下面这张表是 15 次真实搜索（中英文新闻、
 * 技术问答、论坛）里**跨站**对子的实测，单位是归一化后的字：
 *
 * | 类别 | 对子（举例） | 最长共享块 |
 * |---|---|---|
 * | **真转载** | 新浪财经 × 百家号（同一篇财报通稿） | **654** |
 * | | Reuters × Fidelity（同一篇 Fed 稿） | **428** |
 * | | Japan Times × lee.net / Fidelity | **203 / 192** |
 * | | Reuters × Japan Times；Fidelity × lee.net | **148 / 142** |
 * | | Reuters × lee.net（转载时改过几个词） | **94** ← 真转载的下限 |
 * | **通讯社把整段稿子挪进另一篇报道**（两篇是不同的稿子） | Reuters「美元下跌」× Japan Times / Fidelity / lee.net | 239 / 188 / 139 |
 * | **技术内容里两篇不相干的页面共享机器输出** | Qiita × GitHub issue（同一段 Python traceback） | 125 |
 * | | NVIDIA 论坛 × 阿里云（`nvidia-smi` 表头） | 105 |
 * | | Stack Overflow × 各站（一行报错串） | 66–67 |
 * | **各写各的同一件事** | 英文 Fed 报道互相（Politico / France24 / NBC / WSJ / LA Times / Bloomberg） | 16–54 |
 * | | 中文财报报道互相（证券时报 / 东方财富 / 21 世纪）；引同一段财务数字时最高 | 5–21；60 |
 * | | OpenAI 定价那类 SEO 站互相改写 | 8–39 |
 * | | 论坛同题不同帖（HA 社区 × GitHub） | 12–33 |
 * | **同题材 AI 改写** | 搜狐改写稿 × 原稿 | 17 |
 *
 * 三件事从这张表里读得出来：
 *
 * 1. **散文类内容分得很开**：各写各的最高 60（那还是两边照抄同一组财务数字），真转载最低 94。
 * 2. **英文不需要另设一档**。归一化会把空格标点全去掉，120 个字符在英文里只合 20 来个词——
 *    听上去很短，但实测独立英文报道最高只到 54 字，和中文的 60 是同一个量级。
 * 3. **分不开的是「体裁」，不是语言**：技术页面里的 traceback / CLI 输出 / 报错串是机器生成的
 *    定长文本，两篇毫不相干的页面照样一字不差地共享 105–125 字，而更长的堆栈能共享得更多——
 *    **这一类没有任何字数门槛挡得住**，门槛只能挡住实测撞到的这些。同理，通讯社把自己的段落
 *    挪进另一篇报道，139–239 字一字不差却是两篇不同的稿子，也不是这把尺分得开的。
 *
 * 表里的数字都是**下限**：量的时候一篇正文只取到前 ~9.4k 归一化字（`read_url` 的 12k 上限），
 * 长页面的真实共享块只会更长。
 *
 * 整篇里样板占多少完全不影响这个判据——它只看最长的那一段，不看比例。
 *
 * ## 什么时候用哪一把
 *
 * - **`sketchSim`**：两边不同时在场、只存得下指纹时（收件箱归堆——每条 item 入库各算各的，
 *   64 个数存进库）。
 * - **本函数**：两边原文都在手上、而且文本带大量样板时（搜索折叠——一次搜索里当场取当场比）。
 *
 * 返回 0 = 没有任何连续 n-gram 共享。**判不了（一边没文本）由调用方分开表达**，不要
 * 拿 0 冒充。
 */
/**
 * 两段文本归一化后**开头/结尾一模一样的那一截**有多长（字）。
 *
 * 用处只有一个：**同一个站的两个页面天然共享页眉页脚**（导航、免责声明、举报按钮那一排、
 * 备案号），而它在抽出来的正文里**正好就是共同后缀**——实测四个站全是如此，一字不差：
 * 网易号 209 字、澎湃 484 字、百家号 66 字（表在 `src/story-fold/text-fold.ts` 的
 * `sharedStoryRun`）。谁在用、为什么够用、什么时候不够用，都写在那儿。
 */
export function commonPrefixLen(a: string, b: string): number {
  const sa = normalizeForFingerprint(a)
  const sb = normalizeForFingerprint(b)
  let n = 0
  while (n < sa.length && n < sb.length && sa[n] === sb[n]) n++
  return n
}

/** 见 `commonPrefixLen`。 */
export function commonSuffixLen(a: string, b: string): number {
  const sa = normalizeForFingerprint(a)
  const sb = normalizeForFingerprint(b)
  let n = 0
  while (n < sa.length && n < sb.length && sa[sa.length - 1 - n] === sb[sb.length - 1 - n]) n++
  return n
}

export function longestSharedRun(a: string, b: string, gram = GRAM): number {
  const sa = normalizeForFingerprint(a)
  const sb = normalizeForFingerprint(b)
  if (sa.length < gram || sb.length < gram) return 0
  const set = new Set<string>()
  for (let i = 0; i + gram <= sb.length; i++) set.add(sb.slice(i, i + gram))
  let best = 0
  let run = 0
  for (let i = 0; i + gram <= sa.length; i++) {
    if (set.has(sa.slice(i, i + gram))) {
      run++
      if (run > best) best = run
    } else run = 0
  }
  // run 个连着的 n-gram 覆盖 run + n - 1 个字。
  return best === 0 ? 0 : best + gram - 1
}
