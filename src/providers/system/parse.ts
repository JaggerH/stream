import type { SystemIdentity } from './types.ts'

/** 图片/PDF → 文本（`POST /api/conversions kind:parse` 的落点）。成员异构、合同统一为
 *  **一段 markdown**：视觉模型只会吐文本，MinerU 本来就产 markdown，两者在这一个字段下拉平。
 *  版式结构（页/块/坐标）**不进合同**——今天没有任何消费方，塞进来只会逼视觉模型编造它拿不出的
 *  东西。真需要版式那天，另开一个 kind。
 *
 *  顺序即成本阶梯：用户自己加的视觉模型成员（白嫖额度）排前面，MinerU 兜底——它是一条
 *  deterministic-first 管线（born-digital PDF 直接读文字层），对扫描件/长 PDF 仍有视觉模型
 *  给不了的确定性。sequential：第一个不 decline 的成员赢。 */
export const parse: SystemIdentity = {
  id: 'parse',
  category: 'transform',
  serveKeys: ['parse'],
  fallback: false,
  strategy: 'sequential',
  contract: { members: '[{ markdown }]（空 markdown 视同 decline，把机会让给下一个成员）' },
  defaultLabel: '文档解析 / OCR',
  defaultDescription: '图片或 PDF → Markdown 文本',
  defaultMembers: [{ source: '@streamapp/builtin/ocr-mineru' }],
}
