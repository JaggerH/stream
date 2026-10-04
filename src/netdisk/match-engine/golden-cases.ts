import { DEFAULT_MATCH_SPEC, MOVIE_MATCH_SPEC, DEFAULT_EPNUM_REGEX } from '../match-spec.ts'
import type { SpecLeft, SpecRight } from '../match-spec.ts'
import { mulberry32, randomCase, type GoldenCase } from './golden.ts'

/**
 * 金样语料（spec §4.2 的三类输入）。**测试与录基线的脚本读的是同一份**——两边各抄一份的话，
 * 基线迟早对不上它自己声称覆盖的那批输入。
 *
 * 组名即基线的键：**别改已有组的名字**（改了等于删一组加一组，基线对不上要重录），加新形状
 * 就加新组、重录基线。
 */

const L = (leftKey: string, title: string): SpecLeft => ({ leftKey, title })
const LD = (leftKey: string, title: string, durationS: number): SpecLeft => ({ leftKey, title, durationS })
const R = (name: string): SpecRight => ({ name })
const RD = (name: string, durationS: number): SpecRight => ({ name, durationS })
const D = DEFAULT_MATCH_SPEC

/** ① 单测夹具形状。覆盖各档 stage、去重、免检口径、pin、solo、横向闸、覆盖率口径。 */
export const FIXTURES: GoldenCase[] = [
  { name: '干净的号+标题', spec: D, left: [L('a', '020.再谈身边灵异事')], right: [R('020.再谈身边灵异事.mp3')] },
  { name: '撞号但标题不同', spec: D, left: [L('a', '014.六月新闻大盘点')], right: [R('14.辛金.mp3')] },
  { name: '水印重复折叠', spec: D, left: [L('a', '707.风水鱼要在棺材里？')], right: [R('707.风水鱼要在棺材里？【公众号：CunWorkNotes】.mp3'), R('707.风水鱼要在棺材里？【耗时整理‖cunlove.cn】.mp3')] },
  { name: '缺档：号在右侧无文件', spec: D, left: [L('a', '066.凑活聊道德绑架'), L('b', '020.再谈身边灵异事')], right: [R('020.再谈身边灵异事.mp3')] },
  { name: 'title 档兜底：无号年度特辑', spec: D, left: [L('a', '灵异故事-2021年9月特别篇')], right: [R('灵异故事-2021年9月特别篇.mp3'), R('灵异故事-2022年9月特别篇.mp3'), R('灵异故事-2023年9月特别篇【公众号：CunWorkNotes】.mp3')] },
  { name: 'title 档：清洗后完全同名的真平局', spec: D, left: [L('a', '灵异故事-2021年9月特别篇')], right: [R('灵异故事-2021年9月特别篇.mp3'), R('灵异故事-2021年9月特别篇【公众号：CunWorkNotes】.mp3')] },
  {
    name: 'season-episode：tmdb 左键 × 场景命名', spec: D,
    left: [L('tmdb:278624:S01E01', '脚踏实地'), L('tmdb:278624:S01E02', '股掌之间'), L('tmdb:278624:S01E03', '察言观色')],
    right: [R(' 幸运女神 Lucky（2026）/Lucky.S01E01.No.Shortcuts.2160p.Apple.TV+.WEB-DL.DV.HDR.H.265-Ham.mkv'), R(' 幸运女神 Lucky（2026）/Lucky.S01E02.Make.em.Dance.2160p.Apple.TV+.WEB-DL.DV.HDR.H.265-Ham.mkv')],
  },
  { name: 'season-episode：季号也是键（S01 文件不许认 S02 左项）', spec: D, left: [L('tmdb:9:S02E01', '第二季首集')], right: [R('Show.S01E01.1080p.mkv')] },
  {
    name: 'season-episode：单捕获组 fileRegex 救裸集号命名',
    spec: { version: 2, stages: [{ by: 'season-episode', fileRegex: '(\\d{1,3})$', titleStrip: [], threshold: 0, margin: 0.15 }] },
    left: [L('tmdb:1429:S01E01', '致两千年后的你'), L('tmdb:1429:S01E02', '那一天')],
    right: [R('进击的巨人 S01/进击的巨人01.mp4'), R('进击的巨人 S01/进击的巨人02.mp4')],
  },
  { name: 'season-episode：同集双画质无 size → 不乱配', spec: D, left: [L('tmdb:9:S01E01', '首集')], right: [R('Show.S01E01.2160p.mkv'), R('Show.S01E01.1080p.mkv')] },
  { name: 'season-episode：size 判正片 + losers', spec: D, left: [L('tmdb:9:S01E01', '首集')], right: [{ name: 'Show.S01E01.2160p.mkv', size: 500 }, { name: 'Show.S01E01.1080p.mkv', size: 900 }] },
  {
    name: 'season-episode：两档位各两份重复', spec: D, left: [L('tmdb:9:S01E01', '首集')],
    right: [{ name: 'Show.S01E01.1080p.GroupA.mkv', size: 900 }, { name: 'Show.S01E01.1080p.GroupB.mkv', size: 850 }, { name: 'Show.S01E01.720p.GroupA.mkv', size: 500 }, { name: 'Show.S01E01.720p.GroupB.mkv', size: 480 }],
  },
  { name: 'season-episode：size 并列 → 不猜', spec: D, left: [L('tmdb:9:S01E01', '首集')], right: [{ name: 'Show.S01E01.2160p.mkv', size: 500 }, { name: 'Show.S01E01.1080p.mkv', size: 500 }] },
  {
    name: 'season-episode：12 集双版压制（真实活体形状）', spec: D,
    left: Array.from({ length: 12 }, (_, i) => L(`tmdb:296286:S01E${String(i + 1).padStart(2, '0')}`, i === 0 ? '躲在超市后门抽烟的两人' : `第 ${i + 1} 集`)),
    right: Array.from({ length: 12 }, (_, i) => {
      const n = String(i + 1).padStart(2, '0')
      return [
        { name: `Smoking.Behind.the.Supermarket.with.You.2026.S01E${n}.Mini-Episode.${i + 1}.1080p.CR.WEB-DL.AAC2.0.H.264-Pluto@HiveWeb.mkv`, size: 900_000_000 + i },
        { name: `躲在超市后门抽烟的两人.2026.S01E${n}.2160p.CR.WEBRip.HEVC.10bit.AAC.ASSx2.mkv`, size: 700_000_000 + i },
      ]
    }).flat(),
  },
  { name: 'season-episode 对非 tmdb 左键无信号', spec: D, left: [L('lizhi:12345', '020.再谈身边灵异事')], right: [R('020.再谈身边灵异事.mp3')] },
  {
    name: 'v1 扁平谱 lift 成 [epnum,title]',
    spec: { version: 1, epNumRegex: DEFAULT_EPNUM_REGEX, titleStrip: ['【[^】]*】'], threshold: 0.6, margin: 0.15 },
    left: [L('a', '020.再谈身边灵异事')], right: [R('020.再谈身边灵异事.mp3')],
  },
  { name: '4 位年份不当集号', spec: D, left: [L('a', '2022壬寅流年运势解析')], right: [R('2022壬寅流年运势解析.mp3')] },
  {
    name: 'episode-part：第N期上/下集 + 日期前缀', spec: D,
    left: [L('a', '第2期纯享下集：谁在裸辞'), L('b', '第3期纯享上集：谁在加班')],
    right: [R('2026-07-18 第2期纯享下集.mkv'), R('2026-07-25 第3期纯享上集.mkv')],
  },
  { name: 'episode-part：含「上」但不是「上集」', spec: D, left: [L('a', '第10期上流社会')], right: [R('第10期上流社会.mkv')] },
  { name: 'episode-part：裸结构键文件（唯一键免检）', spec: D, left: [L('a', '第1期（一）：开场')], right: [R('第1期一.mkv')] },
  { name: 'epnum：同号两画质', spec: D, left: [L('a', '01.首集')], right: [{ name: '01.首集.1080p.mp4', size: 900 }, { name: '01.首集.720p.mp4', size: 500 }] },
  { name: 'epnum：同号不同标题 → 各自报孤儿', spec: D, left: [L('a', '01.首集')], right: [R('01.首集.mp4'), R('01.别的东西.mp4')] },
  { name: '同名的非媒体文件不算落选副本（字幕）', spec: D, left: [L('a', '01.首集')], right: [R('01.首集.mkv'), R('01.首集.ass')] },
  // ── 时长档 ────────────────────────────────────────────────────────────────
  { name: '时长：编号错位 1、标题相同', spec: D, left: [LD('yile:53', '53.财克印、印克食伤', 2011)], right: [RD('52.财克印、印克食伤.mp3', 2011)] },
  { name: '时长：错位文件不再被真 52 按号抢走', spec: D, left: [LD('yile:52', '52.财克印、印克食伤（上）', 1800), LD('yile:53', '53.财克印、印克食伤', 2011)], right: [RD('52.财克印、印克食伤.mp3', 2011)] },
  {
    name: '时长：编号错位 + 转存重复', spec: D, left: [LD('yile:53', '53.财克印、印克食伤', 2011)],
    right: [{ name: '52.财克印、印克食伤.mp3', durationS: 2011, size: 10 }, { name: '52.财克印、印克食伤【公众号：CunWorkNotes】.mp3', durationS: 2011, size: 9 }],
  },
  { name: '时长：改字避审（0.615 过地板）', spec: D, left: [LD('yile:454', '454.现代版枪下留人', 2605)], right: [RD('455.现代版木仓下留人.mp3', 2605)] },
  { name: '时长：唯一命中但名字一个字不沾（848/209）', spec: D, left: [LD('yile:848', '848.三十探悬疑案件', 8162)], right: [RD('怡乐播客 - 209.十五谈身边灵异事.mp3', 8163)] },
  { name: '时长：容差外差 2s', spec: D, left: [LD('yile:454', '454.现代版枪下留人', 2605)], right: [RD('455.现代版木仓下留人.mp3', 2607)] },
  { name: '时长：整季等长三集', spec: D, left: [LD('tmdb:9:S01E01', '第一集', 3600), LD('tmdb:9:S01E02', '第二集', 3600), LD('tmdb:9:S01E03', '第三集', 3600)], right: [RD('Show.S01E01.1080p.mkv', 3600), RD('Show.S01E02.1080p.mkv', 3600), RD('Show.S01E03.1080p.mkv', 3600)] },
  {
    name: '时长：两集同为 7707s，体量不许硬配', spec: D,
    left: [LD('yile:530', '530.十七探悬疑案件', 7707), LD('yile:820', '820.骗局', 7707)],
    right: [{ name: '530.十七探悬疑案件【公众号：CunWorkNotes】.mp3', durationS: 7707, size: 123368124 }, { name: '820.骗局【耗时整理‖免费分享：cunlove.cn】.mp3', durationS: 7707, size: 123371876 }],
  },
  {
    name: '时长：撞车时精确同名不许被体量挤掉', spec: D, left: [LD('yile:29', '29.十神的生克关系', 1988)],
    right: [{ name: '玄关笔记/29.十神的生克关系.mp3', durationS: 1989, size: 31876857 }, { name: '104.清华大学朱令案.mp3', durationS: 1989, size: 47742674 }],
  },
  { name: '时长：撞车且标题也分不出', spec: D, left: [LD('a', '完全看不出是哪集', 3600)], right: [RD('甲.mp3', 3600), RD('乙.mp3', 3600)] },
  { name: '时长：右侧一个时长都没有', spec: D, left: [LD('a', '020.再谈身边灵异事', 3600)], right: [R('020.再谈身边灵异事.mp3')] },
  {
    name: '时长：显式容差 30s 的自定义谱',
    spec: { version: 2, stages: [{ by: 'duration', toleranceS: 30, titleStrip: [], threshold: 0.6, margin: 0.15 }, { by: 'title', titleStrip: [], threshold: 0.85, margin: 0.15 }] },
    left: [LD('a', '某一集', 1000)], right: [RD('某一集【水印】.mp3', 1020)],
  },
  // ── 横向时长矛盾闸 ────────────────────────────────────────────────────────
  { name: '闸门：名字一样、号也对，时长差出量级', spec: D, left: [LD('a', '005.身边那些灵异事', 2000)], right: [RD('005.身边那些灵异事.mp3', 5808)] },
  { name: '闸门：同桶里时长对得上的照常补位', spec: D, left: [LD('a', '01.首集', 3600)], right: [RD('01.首集.A.mp4', 300), RD('01.首集.B.mp4', 3600)] },
  { name: '闸门：任一侧没时长 → 不生效', spec: D, left: [L('a', '005.身边那些灵异事')], right: [RD('005.身边那些灵异事.mp3', 5808)] },
  { name: '第 3 格：标题档清洗后全等 + 时长差出量级 → 出卡（R14）', spec: D, left: [LD('a', '灵异故事-2021年9月特别篇', 2000)], right: [RD('灵异故事-2021年9月特别篇.mp3', 5808)] },
  { name: '闸门：量级以内的几秒尾巴不受影响（活体 780）', spec: D, left: [LD('a', '780.putt.day', 8274)], right: [RD('780.putt.day.mp3', 8279)] },
  // ── 零竞争 / pin / solo ──────────────────────────────────────────────────
  {
    name: '零竞争：撞进容差的另一份名字一个字不沾', spec: D, left: [LD('yl:005', '005.身边那些灵异事', 5808)],
    right: [RD('怡乐播客 - 005.身边那些灵异事.mp3', 5808), RD('别的节目/999.完全无关.mp3', 5808)],
  },
  { name: '零竞争：唯一沾边但过不了地板（0<sim<0.3）', spec: D, left: [LD('a', '身边那些灵异事的后续故事', 5808)], right: [RD('甲乙丙丁戊己庚辛壬癸子丑寅卯身边.mp3', 5808), RD('完全无关的另一个.mp3', 5808)] },
  { name: 'pin：人裁过的先占位', spec: D, left: [{ leftKey: 'a', title: '020.再谈身边灵异事', pinnedRight: '别的文件.mp3' }], right: [R('020.再谈身边灵异事.mp3'), R('别的文件.mp3')] },
  { name: 'pin：指向的文件这一轮不在右侧', spec: D, left: [{ leftKey: 'a', title: '020.再谈身边灵异事', pinnedRight: '没了.mp3' }], right: [R('020.再谈身边灵异事.mp3')] },
  { name: 'solo：唯一视频文件', spec: MOVIE_MATCH_SPEC, left: [L('tmdb:1:movie', '某部电影')], right: [R('Some.Movie.2026.2160p.mkv'), R('cover.jpg')] },
  { name: 'solo：多画质取体量最大', spec: MOVIE_MATCH_SPEC, left: [L('tmdb:1:movie', '某部电影')], right: [{ name: 'A.2160p.mkv', size: 900 }, { name: 'B.1080p.mkv', size: 500 }] },
  { name: 'solo：体量并列 → 不猜', spec: MOVIE_MATCH_SPEC, left: [L('tmdb:1:movie', '某部电影')], right: [{ name: 'A.mkv', size: 500 }, { name: 'B.mkv', size: 500 }] },
  { name: 'solo：过时长矛盾闸（5 分钟花絮不是正片）', spec: MOVIE_MATCH_SPEC, left: [LD('tmdb:1:movie', '某部电影', 7200)], right: [RD('Extra.mkv', 300)] },
  // ── 归档器那侧的形状（plan.test.ts）────────────────────────────────────────
  { name: '同集其余份收尾：来源版 + 库内同名版（活体 780）', spec: D, left: [LD('yl:780', '780.那一集', 8274)], right: [{ name: '来源/780.那一集.mp3', durationS: 8274, size: 100 }, { name: '库内/780.那一集（补档）.mp3', durationS: 8279, size: 90 }] },
  { name: '同集其余份收尾：同名不同码率', spec: D, left: [LD('yl:1', '001.某一集', 3600)], right: [{ name: '001.某一集.mp3', durationS: 3600, size: 100 }, { name: '001.某一集_0412212803.mp3', durationS: 3600, size: 60 }] },
  {
    name: '整理层：三集混排（配上/歧义/孤儿各一）', spec: D,
    left: [LD('yl:1', '001.身边那些灵异事', 3600), LD('yl:2', '002.太极两仪生四象', 3600), LD('yl:3', '003.骗局', 1800)],
    right: [RD('001.身边那些灵异事.mp3', 3600), RD('002.完全对不上的名字.mp3', 3600), RD('无关的另一个节目.mp3', 999)],
  },
]

/** ② 事故复刻组（05/20/37，用 2026-08-02 取证数字构造）。 */
export const INCIDENTS: GoldenCase[] = [
  {
    name: '事故 05：错名副本（92986927 字节 / 5808s）', spec: D,
    left: [LD('yl:005', '005.身边那些灵异事', 5808), LD('yl:05', '05.太极两仪生四象', 2163)],
    right: [
      { name: '怡乐播客 - 005.身边那些灵异事.mp3', durationS: 5808, size: 92986927 },
      { name: '玄关笔记/05.太极两仪生四象.mp3', durationS: 5808, size: 92986927 },
      { name: '来源/05.太极两仪生四象【耗时整理‖cunlove.cn】.mp3', durationS: 2164, size: 34600000 },
    ],
  },
  {
    name: '事故 20：同形状的另一期', spec: D,
    left: [LD('yl:020', '020.再谈身边灵异事', 4210), LD('yl:20', '20.坎水之象', 1900)],
    right: [
      { name: '怡乐播客 - 020.再谈身边灵异事.mp3', durationS: 4210, size: 51200000 },
      { name: '玄关笔记/20.坎水之象.mp3', durationS: 4210, size: 51200000 },
      { name: '来源/20.坎水之象【耗时整理】.mp3', durationS: 1901, size: 22000000 },
    ],
  },
  {
    name: '事故 37：归档器曾自判成 756 副本（6044s vs 6043s，名字一个字不沾）', spec: D,
    left: [LD('yl:756', '756.那一期节目', 6043)],
    right: [{ name: '756.那一期节目.mp3', durationS: 6043, size: 70000000 }, { name: '玄关笔记/37.申与酉.mp3', durationS: 6044, size: 68000000 }],
  },
]

/** ③ 随机扰动组：种子写死 ⇒ 每次跑的 50 组逐字相同（换了种子 = 换了语料，基线必须重录）。 */
export const RANDOM_SEED = 0x5EED_2026
export function randomCases(count = 50): GoldenCase[] {
  const rnd = mulberry32(RANDOM_SEED)
  return Array.from({ length: count }, (_, i) => randomCase(DEFAULT_MATCH_SPEC, rnd, i))
}

/** 全部 103 组：录基线与跑回归读的是这一个。 */
export const allCases = (): GoldenCase[] => [...FIXTURES, ...INCIDENTS, ...randomCases()]
