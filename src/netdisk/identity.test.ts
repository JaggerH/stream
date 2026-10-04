import { describe, it, expect } from 'vitest'
import { makeIdentity, makeTitleClean } from './identity.ts'

// 参数化练习 makeIdentity 的清洗机制——YILE 不是"旧硬编码行为的等价 fixture"（它的
// titleStrip 混了一条旧代码和现网 config.json 都没有的 `_\d{10}` 时间戳规则，纯粹为了在
// 一份 fixture 里同时练到"通用清洗"和"caller 传入的 titleStrip 数据"两条路径），只是一组
// 顺手好用的怡乐味输入。真正验证"迁移前后行为等价"的是 reconcile/plan.test.ts 里跑真实
// show 配置的用例，不是这里。
const YILE = {
  titleStrip: ['^怡[乐楽樂](?:播客|电台)?\\s*[-–—·]\\s*', '_\\d{10}'],
  epNumRegex: '^(\\d{3})\\.',
}

describe('makeIdentity', () => {
  const id = makeIdentity(YILE)

  it('剥分享者前缀+扩展名+异体字归一（旧 SHOW_PREFIX 等价）', () => {
    expect(id('怡楽播客 - 455.现代版木仓下留人.mp3')).toEqual({ key: '455现代版木仓下留人', num: 455 })
    expect(id('怡乐·455.现代版木仓下留人.m4a').key).toBe('455现代版木仓下留人')
  })

  it('三位零填充才算正片编号（两套编号体系不混判）', () => {
    expect(id('05.玄关笔记之一.mp3').num).toBeNull()   // 两位=子节目编号,不是正片
    expect(id('092.某集.mp3').num).toBe(92)            // 三位=正片,前导零吃掉
  })

  it('剥【水印】与(公众号/整理)括号噪音——内建，不吃 titleStrip', () => {
    expect(id('403.五台山【某公号】.mp3').key).toBe('403五台山')
    expect(id('403.五台山(公众号xx整理).mp3').key).toBe('403五台山')
  })

  it('标点/空白/问号全剥、小写化', () => {
    expect(id('812.要消费？我先帮你审审.mp3').key).toBe('812要消费我先帮你审审')
  })

  it('时间戳尾巴走 titleStrip 数据（caller 传参，不是内建规则）', () => {
    expect(id('812.要消费？我先帮你审审_0628110006.mp3').key).toBe('812要消费我先帮你审审')
  })

  it('异体字归一对文件名主体也生效（不只是被 titleStrip 剥掉的前缀里）', () => {
    expect(id('455.清明樂.mp3').key).toBe(id('455.清明乐.mp3').key)
  })

  it('递归子路径只取 basename', () => {
    expect(id('子目录/455.某集.mp3').key).toBe('455某集')
  })

  it('titleStrip 为空时仍有通用清洗', () => {
    const bare = makeIdentity({ titleStrip: [], epNumRegex: '^(\\d{3})\\.' })
    expect(bare('455.某集【水印】.mp3').key).toBe('455某集')
  })

  it('改名不同则 key 不同——防止标点/归一步骤把两集过度合并（旧 identity.test.ts 等价 fixture）', () => {
    expect(id('341.喂，你等我一吓.mp3').key).not.toBe(id('341.喂，等我一吓啊.mp3').key)
  })

  it('「怡乐电台—」前缀变体（电台+破折号分支）也剥掉', () => {
    expect(id('怡乐电台—092.穿衣服.mp3').key).toBe(id('092.穿衣服.mp3').key)
  })
})

// makeTitleClean 是 makeIdentity 提取集号前那一段清洗的独立导出（spec 2026-07-25），给要按本 show
// 规则拿干净标题的调用方复用——凡是跟集标题比对的地方都得吃同一份 per-show 规则。
// 与 makeIdentity 的区别：不剥标点、不小写——那一步是为了"生成稳定 key"，标题比对方各有自己的
// 口径，信息不能在这一步先丢掉。
describe('makeTitleClean', () => {
  const clean = makeTitleClean(YILE)

  it('剥扩展名/水印/括号噪音/caller titleStrip——与 makeIdentity 共用同一段清洗', () => {
    expect(clean('怡楽播客 - 455.现代版木仓下留人【某公号】.mp3')).toBe('455.现代版木仓下留人')
  })

  it('不剥标点、不小写——这是与 makeIdentity 的差异点', () => {
    expect(clean('812.要消费？我先帮你审审.mp3')).toBe('812.要消费？我先帮你审审')
    expect(clean('455.ABC某集.mp3')).toBe('455.ABC某集')
  })
})
