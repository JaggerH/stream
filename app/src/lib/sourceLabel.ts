type SourceFields = { source_label?: string; source_id?: string; stream_id: string }

/** 条目的源名：一律用后端投影的 `source_label`（源目录里 manifest 的名字，见 docs/API.md
 *  「Items 出线形状里的投影格」）——前端不手写任何源名。没有投影（老记录没带 source_id、源已不在
 *  目录里）就退回原始 stream_id：外观降级，但不会把一个错的名字安到它头上。 */
export function sourceLabel(item: SourceFields): string {
  return item.source_label || item.stream_id
}
