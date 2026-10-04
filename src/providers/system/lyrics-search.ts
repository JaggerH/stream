import type { SystemIdentity } from './types.ts'

/**
 * 歌词检索行。key 两种形态（文法归契约，见 `docs/PACKAGE.md` §2.2 与 `docs/API.md`）：
 * `<platform>:<id>`（已知曲目引用）或 `<title>::<artist>`（模糊）。分流由**源自己**做：
 * 收到别家平台前缀就返回 `[]`（decline，让给梯子的下一档），收到 `::` 形态就模糊搜。
 *
 * 成员 = 目录里 `categories` 含 `lyrics` 且带 `key_param` 的每个源（`registry.inCategory`），
 * resolve 时现取。装一个带歌词源的包就自动进这一行——「加 QQ 音乐歌词只需装包」这句话
 * 从这一版起是真的（spec 2026-09-18-facility-knowledge-stage2-design §2.3）。
 */
export const lyricsSearch: SystemIdentity = {
  id: 'lyrics-search',
  category: 'resolve',
  serveKeys: ['lyrics'],
  fallback: false,
  strategy: 'sequential',
  contract: null,
  defaultLabel: '歌词检索',
  defaultDescription: 'title+artist 或已知曲目引用 → LRC 歌词；装一个带 lyrics 类目源的包即自动加入',
  defaultMembers: [{ mode: 'auto', category: 'lyrics' }],
}
