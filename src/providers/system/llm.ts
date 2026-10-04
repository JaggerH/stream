import type { SystemIdentity } from './types.ts'

/** LLM 调用收口为一条 Provider 行:业务层(总结/聊天/网盘建议)只调这行,不认识具体连接。
 *  **初值不带成员**:连接是用户自己加的 llm-openai 实例(成员自带 {baseUrl,model},key 落
 *  TokenProvider `llm:<实例名>`,见 src/llm/sources.ts)。这里曾经放一个 `{connectionId:'default'}`
 *  占位,它指向一张已退役的连接表,于是永远静默 decline,却让 Providers 页显示"已有成员",把这一行
 *  伪装成配好了的。空列表才是诚实的:页面对"暂无现役成员"有话说(给出添加入口)。
 *  sequential:第一个不 decline 的成员赢。 */
export const llm: SystemIdentity = {
  id: 'llm',
  category: 'llm',
  serveKeys: [],
  fallback: true,
  strategy: 'sequential',
  contract: null,
  defaultLabel: 'LLM',
  defaultDescription: '大模型调用（任意 OpenAI 兼容端点，可叠多个成员按顺序回落）',
  defaultMembers: [],
}
