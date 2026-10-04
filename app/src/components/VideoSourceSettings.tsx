import { SchemaForm } from './config/SchemaForm.tsx'
import type { Connection } from '../lib/api.ts'

/** Source credentials only. Provider enablement, order, and sequential/concurrent strategy
 * remain on the Providers surface.
 *
 * 表单本体是通用 SchemaForm（`/api/config/video-sources`）：字段、密文语义（留空=保留）、
 * 校验全部来自后端下发的 schema——这里只剩说明文案。首个 SchemaForm 消费者（spec
 * 2026-08-17-config-rows-slice1 §5）。 */
export function VideoSourceSettings({ conn }: { conn: Connection }) {
  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        TMDb / OMDb 是详情数据 Source；排序、启用和并行策略在 Provider 配置中管理。
      </p>
      <SchemaForm conn={conn} rowId="video-sources" />
    </div>
  )
}
