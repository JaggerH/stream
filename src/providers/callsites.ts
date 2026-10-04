import type { ProviderCategory } from '../store/types.ts'
import { packageCallsiteDefaults } from './identities.ts'

export type ProviderCallsiteMode = 'fixed' | 'dispatch'
export interface ProviderEntryDescriptor {
  id: string
  label: string
  presenter: string
}

export interface ProviderCallsiteDescriptor {
  id: string
  label: string
  description: string
  category: ProviderCategory
  mode: ProviderCallsiteMode
  defaultProviderIds: string[]
  /** 这个调用点走执行器的 `collect()`——它要的是**全收（并发）语义**下的逐成员成对结果，
   *  由调用点按来源合并字段。绑定校验据此拒绝不支持 collect 的策略（今天即 sequential 与
   *  expand），别让"绑了一条首胜行"这件事拖到详情页真去取数时才炸。 */
  collect?: true
  /** User-visible surfaces from which this capability is available. */
  entries: ProviderEntryDescriptor[]
}

const timeline = [{ id: 'default-timeline', label: '默认时间线', presenter: 'Post Present' }]
const music = [{ id: 'music', label: '音乐', presenter: 'Music Present' }]
const video = [{ id: 'video', label: '视频', presenter: 'Video Present' }]

/**
 * 一个调用点的默认行列表 = **宿主自己的默认 ∪ 声明了这个调用点的包行**（去重，宿主在前）。
 *
 * 为什么是 getter 而不是在 `PROVIDER_CALLSITES` 上算一次：这张表是模块级常量，模块加载早于
 * 包装配；算一次就等于「包永远没声明过」，而且没有任何一处会喊。消费方（`ensureDefaults` /
 * `restore` / `/api/provider-callsites`）照旧读 `.defaultProviderIds`，读到的是现取的值。
 * （spec 2026-09-18-facility-knowledge-stage2-design §2.3）
 */
export function callsiteDefaultsFor(callsiteId: string, hostDefaults: string[] = []): string[] {
  return [...new Set([...hostDefaults, ...(packageCallsiteDefaults().get(callsiteId) ?? [])])]
}

export const PROVIDER_CALLSITES: ProviderCallsiteDescriptor[] = [
  { id: 'video.detail.canonical', label: '影视权威标识', description: '发现信息验证为可复用的 TMDb/IMDb 标识', category: 'metadata', mode: 'fixed', defaultProviderIds: ['video-canonical'], collect: true, entries: video },
  { id: 'video.detail.metadata', label: '影视元数据', description: '作品详情的文字、人员和评分', category: 'metadata', mode: 'fixed', defaultProviderIds: ['video-metadata'], collect: true, entries: video },
  { id: 'video.detail.images', label: '影视图片', description: '作品详情的海报与横幅', category: 'images', mode: 'fixed', defaultProviderIds: ['video-images'], collect: true, entries: video },
  { id: 'search.music', label: '音乐搜索', description: '音乐搜索结果', category: 'search', mode: 'fixed', defaultProviderIds: ['music-search'], entries: music },
  // 取歌是**按平台派发**的：哪家平台由哪条行取，取决于装了谁的包（行的 serveKeys 里带平台键）。
  // 宿主自己不认识任何平台，所以宿主默认为空——默认行由包的 `stream.providers[].callsites` 填。
  { id: 'music.track.resolve', label: '音乐播放解析', description: '歌曲播放请求 → 可播放地址', category: 'resolve', mode: 'dispatch', get defaultProviderIds() { return callsiteDefaultsFor('music.track.resolve') }, entries: music },
  { id: 'music.track.download', label: '音乐下载解析', description: '歌曲下载任务 → 可下载地址', category: 'resolve', mode: 'dispatch', get defaultProviderIds() { return callsiteDefaultsFor('music.track.download') }, entries: music },
  { id: 'search.content', label: '内容搜索', description: '跨平台内容搜索', category: 'search', mode: 'fixed', defaultProviderIds: ['content-search'], entries: timeline },
  { id: 'search.price', label: '比价搜索', description: '商品比价搜索 → 各平台报价', category: 'search', mode: 'fixed', defaultProviderIds: ['price-search'], entries: timeline },
  { id: 'search.resale', label: '残值搜索', description: '型号 → 二手回收 / 挂牌价', category: 'search', mode: 'fixed', defaultProviderIds: ['resale-search'], entries: timeline },
  // 时间线 + 影视两个现场都用它：影视作品页的「找资源」就地换 Provider 写的正是这个槽位，
  // 挂上 video 后该覆盖才出现在 video Present 的 slots 里、能在频道管理里看见并清掉（同 netdisk.* 的双挂法）。
  { id: 'search.resources', label: '资源搜索', description: '影视与下载资源搜索', category: 'search', mode: 'fixed', defaultProviderIds: ['resource-search'], entries: [...timeline, ...video] },
  { id: 'search.video', label: '影视搜索', description: '影视片名搜索 → 候选作品', category: 'search', mode: 'fixed', defaultProviderIds: ['video-search'], entries: video },
  { id: 'download.resolve', label: '下载链接解析', description: '下载页面链接解析', category: 'resolve', mode: 'fixed', defaultProviderIds: ['download-resolve'], entries: timeline },
  // 贴链接抓媒体按 `<platform>-link` 派发（平台来自认领函数 `recognizeLinkSync`）：`dispatch()` 只在这个调用点
  // **绑定里**的行中挑，所以包声明的 transform 行（serveKeys 是 `<platform>-link`）必须经 `callsites: ['content.enrich']` 进默认才可达——
  // 只声明 serveKeys 不进默认的行，键再对也永远派发不到它，而没有一处会喊。宿主自己的默认只有
  // `fetch-url` 这一条兜底行（抖音 / 直链）。
  { id: 'content.enrich', label: '内容富化', description: '按链接认领到的平台（<platform>-link）选择内容富化 Provider', category: 'transform', mode: 'dispatch', get defaultProviderIds() { return callsiteDefaultsFor('content.enrich', ['fetch-url']) }, entries: timeline },
  // 视频播放按平台派发：哪家平台由哪条行解析，取决于装了谁的包（行的 serveKeys 里带 `<平台>-video`）。
  // 宿主自己不认识任何平台，所以宿主默认为空——默认行由包的 `stream.providers[].callsites` 填
  // （同 music.track.resolve）。
  { id: 'video.resolve', label: '视频播放解析', description: '按平台选择视频播放 Provider', category: 'resolve', mode: 'dispatch', get defaultProviderIds() { return callsiteDefaultsFor('video.resolve') }, entries: video },
  // 网盘分享的两步（先验活、再从活的里选一个转存）。dispatch 键 = `<网盘>-verify` / `<网盘>-save`
  // ——和 video.resolve 的 `<平台>-video` 同构；加百度/阿里只是加行，调用点零改动。
  // category=resolve：verify(pwd_id)→判决对象 / save(pwd_id)→结果对象，语义上就是「key → 一个对象」
  // （身份住代码，存量库里那一列是死数据，不需要迁移）。
  // 宿主自己不认识任何网盘，所以四个网盘调用点的宿主默认都为空——默认行由网盘包的
  // `stream.providers[].callsites` 填（同 music.track.resolve）。
  { id: 'netdisk.share.verify', label: '网盘分享验活', description: '按网盘选择验活 Provider：分享链接 → 是否存活 + 文件列表', category: 'resolve', mode: 'dispatch', get defaultProviderIds() { return callsiteDefaultsFor('netdisk.share.verify') }, entries: [...timeline, ...video] },
  { id: 'netdisk.share.save', label: '网盘分享转存', description: '按网盘选择转存 Provider：把选中的分享存进用户网盘的落点目录', category: 'resolve', mode: 'dispatch', get defaultProviderIds() { return callsiteDefaultsFor('netdisk.share.save') }, entries: [...timeline, ...video] },
  // 网盘视频播放：按网盘选择播放 Provider（文件 fid → 转码可播流）。和上面两个 netdisk.share.* 同构，
  // 加一家网盘的转码播放只是它的包加一行、播放路由零改动。
  { id: 'netdisk.play', label: '网盘视频播放解析', description: '按网盘选择播放 Provider：文件 fid → 可播放流地址', category: 'resolve', mode: 'dispatch', get defaultProviderIds() { return callsiteDefaultsFor('netdisk.play') }, entries: video },
  // 网盘文件夹跳转：按网盘选择 Provider（路径段 → 网盘网页文件夹 URL）。同上，加网盘只加行。
  { id: 'netdisk.folder', label: '网盘文件夹跳转', description: '按网盘选择跳转 Provider：路径段 → 网盘网页文件夹 URL', category: 'resolve', mode: 'dispatch', get defaultProviderIds() { return callsiteDefaultsFor('netdisk.folder') }, entries: [...timeline, ...video] },
  // llm-provider-unification：三条 llm 调用点。绑定选的是「哪条 Provider 行」，绑定的
  // `params.model` 是这条任务的模型覆盖（不填 = 用梯子上各成员自己的默认 model）。
  { id: 'llm.summarize', label: 'LLM 摘要', description: '转写/正文摘要使用的模型', category: 'llm', mode: 'fixed', defaultProviderIds: ['llm'], entries: timeline },
  // extract 窄回执（spec 2026-08-24-extract-narrow-receipt）：正文超 4000 字符时把它压成带出处的
  // 要点清单。逐条 item 的批量压缩作业，输入长、判断浅（摘录+引用，不需要复杂推理），适合绑一个
  // 便宜模型，所以单列一个调用点、不混进 llm.summarize。
  { id: 'llm.extract_digest', label: 'LLM 正文摘要(extract 窄回执)', description: 'extract 工具长正文压缩为带出处的要点清单', category: 'llm', mode: 'fixed', defaultProviderIds: ['llm'], entries: timeline },
  { id: 'llm.chat', label: 'LLM 对话', description: 'Agent 聊天与端点解析使用的模型', category: 'llm', mode: 'fixed', defaultProviderIds: ['llm'], entries: timeline },
  // AI 介入的一问一答（spec 2026-09-11-ai-intervention-design §4）：一张截图 + 一份元素表进去、几条特征
  // 出来。要视觉模型，所以单列调用点、不混进 llm.chat——用户可以只给它绑一个带视觉的成员。
  { id: 'intervention.ask', label: 'AI 介入（认界面）', description: 'recipe 认不出当前界面时问一次：这是哪儿 / 拿什么区分 / 下一步点哪', category: 'llm', mode: 'fixed', defaultProviderIds: ['llm'], entries: timeline },
  // id 保持 `netdisk.spec.suggest`（用户已有的绑定按 id 存盘，改 id 等于把他们的模型选择清零）。
  // 今天它只剩季归属这一个消费方：匹配规格改由对话里的模型写（netdisk_residue → preview → apply）。
  { id: 'netdisk.spec.suggest', label: '网盘季归属判定', description: '结构指纹判不出时，让模型读文件夹名猜这批文件属于哪一季', category: 'llm', mode: 'fixed', defaultProviderIds: ['llm'], entries: [...timeline, ...video] },
  // 搜索结果折叠的第 3 档：「这几篇网页是不是在报道同一件事」。单独一个调用点是为了让它能绑一个
  // 便宜的模型——它的活是判同异，不需要和对话/摘要同一档的模型（判据见 src/story-fold/semantic-fold.ts）。
  { id: 'story-fold.semantic', label: '搜索结果同源判定', description: '判断几条搜索结果是不是在报道同一件事（折叠的第三档判据）', category: 'llm', mode: 'fixed', defaultProviderIds: ['llm'], entries: timeline },
  // 桌面 recipe 的 `see` 走到 model 段（a11y / 屏幕文字 / 模板都落空）时问的那一句：「编号里哪个是目标」。
  // 单列调用点是为了让用户绑一个**看图准**的模型——它的活是视觉定位，不是对话。
  { id: 'desktop.see', label: '桌面视觉定位', description: '桌面 recipe 找不到控件树 / 屏幕文字时，让视觉模型在编号截图里指出目标', category: 'llm', mode: 'fixed', defaultProviderIds: ['llm'], entries: timeline },
  // 梯子最后一档：前四档全落空时问「它在屏幕的哪个位置」。**和上面那条是两种活**——那条在
  // 已有的候选里挑一个编号（挑不出来就是元素表里没有这个东西），这条要报绝对坐标。
  // 所以这一格该绑一个 GUI 专用的定位模型（UI-TARS 系），绑成对话模型会一直不准且没人会喊。
  { id: 'desktop.point', label: '桌面坐标定位', description: '桌面 recipe 前四档全落空时，让 grounding 模型直接报出目标在窗口里的坐标', category: 'llm', mode: 'fixed', defaultProviderIds: ['llm'], entries: timeline },
]

export const providerCallsite = (id: string): ProviderCallsiteDescriptor | undefined => PROVIDER_CALLSITES.find((callsite) => callsite.id === id)
