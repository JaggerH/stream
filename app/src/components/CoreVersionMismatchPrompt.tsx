import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.tsx'
import { Button } from './acrylic/button.tsx'

/**
 * M3 版本偏斜校验（backend-lifecycle-decouple Task 3.2, layered-install spec
 * "Version-skew guard at shell startup"）。壳（Rust `supervise_sidecar`）读
 * `~/.stream/core/pointer.json`，发现指针版本与壳要求的 major 不兼容时不 spawn/reuse
 * 那个 core，而是 emit `core-version-mismatch`（payload `{required, found}`）——
 * App.tsx 监听该事件、挂载本组件。没有可执行的"一键刷新"动作（升级 core 是安装层面
 * 的事，超出壳进程能做的范围），因此只提示、不代为操作；确认后仅关闭本提示，壳仍不
 * 会驱动那个不兼容的 core（streamapi 继续 503，直到用户手动更新 core 后重启壳）。
 */
export function CoreVersionMismatchPrompt({
  required,
  found,
  onDismiss,
}: {
  required: string
  found: string
  onDismiss: () => void
}) {
  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>core 版本不兼容</DialogTitle>
          <DialogDescription>
            当前发现的 core 版本为 {found}，与壳要求的版本 {required}
            不兼容。请将 core 刷新到同一发行渠道下的兼容版本后重启 Stream。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="default" size="medium" onClick={onDismiss}>
            知道了
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
