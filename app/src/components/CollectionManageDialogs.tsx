import type { Collection } from '../lib/types.ts'
import { Button } from './acrylic/button.tsx'
import { Input } from './acrylic/input.tsx'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.tsx'

/**
 * 重命名/删除集合(播单/片单)的共享确认框对——音频侧「播单」和影视侧「片单」共用同一套弹层结构。
 * 组件本身域中立、语言中立:只渲染调用方给的完整句子,绝不拼接任何汉字/名词到模板里(上一版的
 * `noun`/`deleteNote` 拼接对 en 侧是错的——`删除list`/`list名称`这种半中半英——对 zh 侧也是错的,
 * `deleteNote` 前少一个连接词就是个语病病句。deleteBody 接收 label 现算,因为删除确认框的正文
 * 天然要点名"删的是哪个"。 */
export function CollectionManageDialogs(p: {
  renaming: Collection | null
  deleting: Collection | null
  renameLabel: string
  onRenameLabelChange: (v: string) => void
  onCloseRename: () => void
  onCloseDelete: () => void
  onConfirmRename: () => void
  onConfirmDelete: () => void
  renameSaving?: boolean
  deleteSaving?: boolean
  /** 重命名弹层的完整标题/说明/输入框 aria-label——调用方给成品句子,不给零件。 */
  renameTitle: string
  renameDesc: string
  nameLabel: string
  /** 删除确认弹层的完整标题;正文按被删对象的 label 现算(点名删的是哪个)。 */
  deleteTitle: string
  deleteBody: (label: string) => string
}) {
  const { renaming, deleting, renameLabel, onRenameLabelChange, onCloseRename, onCloseDelete, onConfirmRename, onConfirmDelete, renameSaving, deleteSaving, renameTitle, renameDesc, nameLabel, deleteTitle, deleteBody } = p
  return (
    <>
      <Dialog open={renaming !== null} onOpenChange={(open) => { if (!open) onCloseRename() }}>
        <DialogContent>
          <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); onConfirmRename() }}>
            <DialogHeader>
              <DialogTitle>{renameTitle}</DialogTitle>
              <DialogDescription>{renameDesc}</DialogDescription>
            </DialogHeader>
            <div className="px-4 py-2">
              <Input
                aria-label={nameLabel}
                size="xl"
                value={renameLabel}
                onChange={(e) => onRenameLabelChange(e.target.value)}
                autoFocus
              />
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="neutral" size="large" disabled={renameSaving}>取消</Button>
              </DialogClose>
              <Button type="submit" size="large" disabled={renameSaving || !renameLabel.trim()}>
                {renameSaving ? '保存中…' : '保存'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={deleting !== null} onOpenChange={(open) => { if (!open) onCloseDelete() }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{deleteTitle}</DialogTitle>
            <DialogDescription>
              {deleteBody(deleting?.label ?? '')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="neutral" size="large" disabled={deleteSaving}>取消</Button>
            </DialogClose>
            <Button type="button" variant="destructive" size="large" disabled={deleteSaving} onClick={onConfirmDelete}>
              {deleteSaving ? '删除中…' : '删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
