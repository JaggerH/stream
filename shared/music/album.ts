/** 「这首歌的专辑名是什么」——**前后端唯一真相源**。
 *
 *  数据模型里没有结构化的 album 字段，专辑名只能从文本里的 `专辑：X` 解析。两种形态都要吃：
 *  RSSHub 原始 description 是 `<br>` 拼的 html，入库归一化之后的 `content.text` 是纯文本、
 *  下一段常常直接跟着「发行…」。
 *
 *  两侧解析的结果流进的是**同一个下游**：写进音频文件的 ID3 专辑标签。行内菜单下载走前端
 *  （`row.album` 随 `POST /api/downloads` 的 `track.album` 上来），下载整单走后端
 *  （`extractTrackRef`）。判据一旦分家，同一首歌用两个入口下，写进文件的专辑名就不一样，
 *  而两边单看都"正常"、没有任何测试会响。所以这份实现只允许存在一处。 */
export function albumFromText(text: string | undefined): string | undefined {
  const m = (text ?? '').match(/专辑[：:]\s*(.+?)(?:<br>|<\/|\r?\n|发行|$)/)
  const album = m?.[1]?.trim()
  return album || undefined
}
