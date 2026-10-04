// src/no-facility-names.guard.test.ts
// 守的是 spec 2026-09-18-facility-knowledge-in-package 的不变量：外部站点的知识住在它的包里，
// 源码只留泛化机制。名单里的站今天已经"干净"（五站全在）；以后再有站搬完就加进来，一旦有人把站名
// 写回源码这里当场变红。
// `163\.com` 是转义过的正则源串（`new RegExp(name,'i')` 吃它）——裸 `163` 会打到端口号、
// 哈希片段一类的无辜数字，那种红没人修得动，只会被注释掉，于是整道闸失效。
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLEAN_FACILITIES = [
  'lizhi', 'xiaoyuzhou', 'netease', '163\\.com', '网易云',
  // 第三站（spec 2026-09-19-facility-knowledge-stage3-design）
  // `hdslb` 刻意不收：src/http/image-fetch.ts 头注里那张十个图床的实测表含它，那是实验数据。
  'bilibili', 'b23\\.tv', '哔哩', 'bilivideo',
  // 裸的 `bili` 词干，但放过 capability / mobility 这类恰好含它的英文词。
  // 注意这张表用 `new RegExp(name, 'i')` 编译：`(?![a-z])` 在 i 标志下也排除大写字母，
  // 所以 `BiliComment` 这种驼峰不会被这一条抓到——它靠上面那条 `bilibili` 或靠没人再写它。
  '[Bb]ili(?![a-z])',
  // 第四站（spec 2026-09-19-facility-knowledge-stage4-design）：抖音 / TikTok。
  // 这一组收的是**代码级知识**，不是裸词：**刻意不收裸 `douyin` / `抖音`**。源码里有几十处散文注释
  // 把抖音当活体证据引用（哪天、哪条 item、多少帧、哪个 CDN 拒了 curl），那是数据不是知识——
  // 改成"某短视频平台"只会让证据失真，同 `hdslb` 那条先例。
  // 判据一句话：源码不认识它 = 没有它的域名、标识符、字面量、包名、源 id；提到它的名字讲一段实测，不算认识。
  // 域名
  'douyin\\.com', 'iesdouyin', 'tiktok\\.com',
  // 上游数据形状里的字段名（aweme_id / aweme_detail），出现就说明有人在源码里读容器的响应
  'aweme',
  // 包名 / service 名 / 环境变量前缀
  'Douyin_?Tik[Tt]ok', 'douyin-tiktok', 'DOUYIN_',
  // 标识符：douyinApiUrl / douyinUrl / douyinAdapter / tiktokNormalizer…
  // `(?!pic)` 放过 `douyinpic`：这张表按 `i` 标志编译，`[A-Z]` 于是也吃小写，会打到
  // src/http/image-fetch.ts 头注里那张十个图床的实测表（与 `hdslb` 同一张表、同一个理由：实验数据）。
  'douyin(?!pic)[A-Z]\\w*', '[tT]iktok(Normalizer|Response|Cookie)',
  // 字面量：平台名与源 id（'douyin' / 'douyin-follow' / 'tiktok'）
  '[\'"]douyin[\'"]', '[\'"]douyin-[a-z-]+[\'"]', '[\'"]tiktok[\'"]',
  // 第五站（spec 2026-09-20-facility-knowledge-stage5-design）：小红书。
  // 与第四站同一条线——收的是**代码级知识**，不收裸 `xhs` / `小红书`：源码里的散文注释拿它当活体证据
  // （哪天、哪条 recipe、locate 几秒），那是数据不是知识。
  // 刻意不收 `xhscdn`：src/http/image-fetch.ts 头注里那张十个图床的实测表含 `sns-webpic-qc.xhscdn.com`
  // （与 `hdslb` / `douyinpic` 同一张表、同一个理由：实验数据）。
  // 刻意不收 `noteId`：它是 recipe 契约里的参数名，讲 locate / detail 参数的散文到处都在用它。
  // 域名 / 上游签名参数
  'xiaohongshu\\.com', 'xsec_?[tT]oken',
  // 字面量：平台名与源 id（'xhs' / 'xhs-detail' / 'xiaohongshu'）
  '[\'"]xhs[\'"]', '[\'"]xhs-[a-z-]+[\'"]', '[\'"]xiaohongshu[\'"]',
  // 包名 / 系统流 id / 事件与调试前缀
  '@streamapp/xhs', 'system-xhs', '__xhs_',
  // 标识符：xhsShadow… / xhsOpen / xhsInteract / xhsNormalizer / xhsNoteId / XhsImage / XhsStream / XhsComment…
  '[xX]hs(Shadow|Open|Interact|Normalizer|NoteId|Image|Stream|Comment)\\w*',
  // 第六批（2026-09-24，四路并行）：雪球 / Telegram / BT影视 / 盘搜 / BT之家 / Groq / Firecrawl /
  // 购物线五站。判据同第四、五站——收**代码级知识**（域名、源 id 字面量、包名、专用标识符、专用
  // 配置项），不收裸词：源码里的散文注释拿它们当活体证据。
  // 雪球：`雪球App` 是站方注入的出处前缀（代码级），裸 `雪球` 是散文。
  // 裸 `xueqiu.com` 是散文（WAF 实测、Radar 例子）；带协议的 URL 形式才是代码。
  'https://xueqiu\\.com', '雪球App', '[\'"]xueqiu[\'"]', '[\'"]xueqiu-[a-z-]+[\'"]', '@streamapp/xueqiu',
  '[xX]ueqiu(Normalizer|Url|Quote)\\w*',
  // Telegram：只收包名 / 源 id / 标识符。裸 `telegram` 与 `t\.me` 刻意不收——`app:Telegram.exe` 是桌面
  // 目标的示例字符串；search agent 把 t.me 当一种「窝」分级，那是发现循环对整个网的判据，不是这个包的。
  '@streamapp/telegram', '[\'"]telegram-[a-z-]+[\'"]', '[tT]elegramNormalizer',
  // BT影视 / BT之家 / 盘搜：域名、源 id、专用配置项与专用解析器名。裸 `btbtla` / `1lou` / `pansou`
  // 是散文（解析器头注拿它们当形状的例子、standby / compose 拿盘搜当容器插件的例子）。
  // `@streamapp/btbtla` 不收：source-health-view.ts 的头注拿它举一个"全名与裸名各出一行"的实测例子。
  'btbtla\\.com', 'BTBTLA_', '[\'"]btbtla[\'"]', '[\'"]btbtla-[a-z-]+[\'"]',
  'rsshub:1lou', '[\'"]1lou[\'"]', '@streamapp/1lou',
  'pansou_url', 'pansouUrl', 'PANSOU_', 'PansouResult', 'extractPansou',
  '[\'"]pansou[\'"]', '[\'"]pansou-[a-z-]+[\'"]', '@streamapp/pansou',
  // Groq / Firecrawl：端点、模型、旧 builtin 成员名、客户端标识符。**梯子默认成员里的包源全名**
  // （`@streamapp/groq/groq-whisper` / `@streamapp/firecrawl/article-firecrawl`）与 `GROQ_API_KEY`
  // 的环境变量映射刻意不收：顺序是宿主的成本 / 隐私判断，包没有「插进宿主梯子某个位置」的声明位；
  // 环境变量名同理没有声明位（见 src/kernel/plugins/credentials.ts）。
  // `whisper-large-v3` 刻意不收：它同时是 Cloudflare 那档的模型名，转写实测注释里也到处是。
  'api\\.groq\\.com', 'transcribe-groq', 'firecrawl\\.dev', '[fF]irecrawl(Client|Adapter|Fn)',
  'content/firecrawl', 'makeArticleFirecrawlFn',
  // 购物线：域名、包名、源 id、专用标识符。裸 `ZOL` / `慢慢买` / `闲鱼` 是散文（限速来历、实测记录）。
  'zol\\.com\\.cn', 'manmanbuy\\.com', 'aihuishou\\.com', 'goofish\\.com', 'zhuanzhuan\\.com',
  '@streamapp/(zol|manmanbuy|aihuishou|goofish|zhuanzhuan)',
  '[\'"](zol|manmanbuy|aihuishou|goofish|zhuanzhuan)(-[a-z-]+)?[\'"]',
  '[zZ]ol(Universe|Phones)\\w*', 'universe-zol',
  // 第七批（2026-09-24）：夸克 / 百度网盘的 Provider 行归 packages/{quark,baidu}。只收行 id 字面量与
  // 身份标识符：`pan.quark.cn` 这类链接判别正则是「一条链接是哪种网盘」的领域模型（还覆盖没有包的
  // 阿里 / 115 / UC），`quark-save` 三个 builtin mode 是宿主对 shared/netdisk 逻辑的通用实现，都不算
  // 包知识；散文注释里「netdisk-save-quark 行的成员」是在讲归属，不收裸名。
  '[\'"]netdisk-(verify|save|play|folder)-(quark|baidu)[\'"]', 'netdisk(Verify|Save|Play|Folder)(Quark|Baidu)',
  // 第八批（2026-09-24）：V2EX / Hacker News 评论富化归 packages/{v2ex,hackernews}。裸 `v2ex\.com` 不收：
  // search agent 判「讨论站」的那串域名（与 zhihu / reddit 并列）是发现循环对整个网的判据；ad-filter 的
  // 头注拿 v2ex 的推广节点举例，是散文。
  'v2ex\\.com/api', '[\'"]v2ex[\'"]', '[\'"]v2ex-[a-z-]+[\'"]', '[vV]2ex(Reply|Id|Comments)\\w*', 'fetchV2ex',
  'ycombinator', 'hnId', 'fetchHn\\w*', 'HnStory', '[\'"]hackernews[\'"]', '[\'"]hackernews-[a-z-]+[\'"]',
  // 第八批·后端残留（spec 2026-09-26-backend-residue-stage8-design）：影视榜单 normalizer 与豆瓣图床
  // Referer / 6 条 RSSHub 资源站的搜索元数据 → packages/rsshub；字幕搜刮 → packages/{xunlei,shooter}；
  // Cloudflare 转写 → packages/cloudflare。每条都在搬家前的基线（64093c1b）上核过是红的。
  // 影视：域名、上游 RSS 文案、平台字面量与源 id。**刻意不收 `['"](imdb|tmdb)['"]`**：`'tmdb'` 是宿主
  // 的领域模型（绑定左键 `kind: 'tmdb'`、`tmdb-canonical` 等身份行，搬完仍命中 17 个文件），`'imdb'`
  // 是作品身份字段（`video/item-identity.ts` 的外部 id）——那是宿主认识的「作品」，不是某个站。
  // 裸 `douban` / `豆瓣` 是散文（image-fetch.ts 头注的 UA 实测）。
  'movie\\.douban\\.com', 'doubanio\\.com', 'IMDb RATING', 'User Score:',
  '[\'"]douban[\'"]', '[\'"]douban-[a-z-]+[\'"]',
  // 资源搜索：站内搜索页的域名。裸站名（nyaa / comicat / u3c3 / javdb）是散文，resource-search 行的注释
  // 拿它们讲参数名与「成人站另立 Provider」的决策；成员引用本身是目录路由 id（`rsshub:nyaa/…`），
  // 不归任何包命名空间、也不是站点知识，所以留在宿主。
  'nyaa\\.si', 'comicat\\.org', 'u3c3\\.com', 'javdb\\.com',
  // 字幕：接口路径与字幕 CDN。**不收裸 `xunlei`**：`pan.xunlei.com` 是网盘链接判别的领域模型
  // （一条链接是哪种网盘，覆盖没有包的网盘）。
  'xunlei\\.com/oracle', 'shooter\\.cn/api', 'geilijiasu',
  // Cloudflare：端点与客户端类名。**不收** `CLOUDFLARE_*` 环境变量名（部署知识，宿主的回落表与
  // TokenProvider 表都在用，同 `GROQ_API_KEY` 先例）、梯子默认成员的包源全名（顺序是宿主的成本判断）。
  'api\\.cloudflare\\.com', 'CloudflareBackend',
  // 第九批（spec 2026-09-26-boundary-stage9-design §2.4）：OMDb 客户端 → packages/omdb。端点与旧 builtin
  // 工厂名，搬家前都核过是红的。**不收** `omdbApiKey`：它是宿主「影视源设置」老配置的键名，回落投影
  // （`SettingsStore.runtimeConfig('omdb')`）按 spec 留在宿主；裸 `OMDb` 是界面文案与散文。
  'omdbapi\\.com', 'makeOmdb\\w*',
]

/**
 * 扫描根：**宿主的全部源码**，不只是后端（spec 2026-09-26-host-package-boundary-design §3）。
 * 前端、扩展、DSH 产物、能力包、前后端共用的 shared/ 同一张名单——守卫只盯后端时，前端是一个没人
 * 盯的口子，每搬一个站前端照样会漏。每个根带一个「至少扫到这么多文件」的下限：走空了也是没命中，
 * 而且和真干净长得一模一样。
 */
const REPO = fileURLToPath(new URL('..', import.meta.url))
const CAPABILITIES = join(REPO, 'capabilities')
const ROOTS: Array<{ root: string; min: number }> = [
  { root: 'src', min: 200 },
  { root: 'shared', min: 30 },
  { root: 'app/src', min: 200 },
  { root: 'extension/src', min: 20 },
  { root: 'hosts/dsh/src', min: 20 },
  ...readdirSync(CAPABILITIES)
    .filter((d) => statSync(join(CAPABILITIES, d, 'src'), { throwIfNoEntry: false })?.isDirectory())
    .map((d) => ({ root: `capabilities/${d}/src`, min: 2 })),
]

/** 按**完整路径**豁免的生成物。不按目录名豁免——放宽成目录名，就等于在源码里挖一个不报警的口子。 */
const GENERATED = new Set([
  // RSSHub 全站命名空间 → 域名的生成表（文件头写着生成脚本 scripts/gen-source-domains.mjs）：整网目录，不是站点知识。
  'app/src/lib/source-domains.ts',
])

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    // 只豁免 `__fixtures__`（测试夹具里出现站名是数据，不是源码认识它）。一个恰好叫
    // `fixtures` 的普通目录照扫——豁免名放宽一格，就等于在源码里挖了一个不报警的口子。
    // `node_modules` 不是源码（hosts/ 下的子项目自带包管理，装过依赖就会有它）。
    if (statSync(p).isDirectory()) { if (name !== '__fixtures__' && name !== 'node_modules') yield* walk(p); continue }
    // `golden-*.ts` / `gold.ts` 是录过基线的金样语料：里面的站名是**输入数据**，改一个字就要重录基线
    // （实测：把一条左键从站名改成中性前缀，金样账当场对不上）。豁免它，别把这道闸变成
    // 「改注释顺手要重录基线」。`src/video/content/eval/gold.ts` 是资源搜索解析的那份金样，同理。
    if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name) || /^golden-|^gold\.ts$/.test(name)) continue
    if (GENERATED.has(relative(REPO, p).split('\\').join('/'))) continue
    yield p
  }
}

describe('宿主源码不认识任何已搬进包的 facility', () => {
  const byRoot = ROOTS.map(({ root, min }) => ({ root, min, files: [...walk(join(REPO, root))] }))
  const files = byRoot.flatMap((r) => r.files)

  /** 这道闸的判据是"扫完一遍没命中"。走空了也是没命中，而且和真干净长得一模一样——
   *  改坏 walk（豁免写宽了、扩展名写错了、根写错了）会让整条守卫静默失效。每个根各自钉住"确实扫到了东西"。 */
  it.each(byRoot.map((r) => [r.root, r.min, r.files.length] as const))('确实走到了 %s（至少 %i 个文件，实际 %i）', (_root, min, count) => {
    expect(count).toBeGreaterThan(min)
  })

  it('扫描根里确实有能力包（capabilities/*/src 一个都没找到 = 这一格静默失效）', () => {
    expect(ROOTS.some((r) => r.root.startsWith('capabilities/'))).toBe(true)
  })

  it.each(CLEAN_FACILITIES)('宿主源码里没有 "%s"', (name) => {
    const re = new RegExp(name, 'i')
    const hits = files.filter((f) => re.test(readFileSync(f, 'utf8'))).map((f) => relative(REPO, f))
    expect(hits, `这些文件仍写着 ${name}，知识该住在 packages/<那个站>/（前端只渲染包声明、后端投影的东西，见 docs/PACKAGE.md「宿主与包的边界」）`).toEqual([])
  })
})
