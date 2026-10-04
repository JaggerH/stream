import type { ReactNode } from 'react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table.tsx'
import { cn } from '../../lib/utils.ts'

/** 一列的规格：表头文案 + 宽度 + 对齐 + 怎么把一行数据渲染成单元格。 */
export interface DebugColumn<Row> {
  header: ReactNode
  /** 百分比宽度，如 '45%'。 */
  width: string
  align?: 'left' | 'center' | 'right'
  /** 表头的原生 tooltip（RSS 那种需要一整段解释的列）。 */
  title?: string
  cell: (row: Row) => ReactNode
  className?: string
}

/**
 * DebugBox 里所有小表格的唯一实现。
 *
 * 之前 StackTrace / PluginStatus / RecipeTiming 三张表把同一套 `h-6 py-0.5 px-2 text-[10px]
 * font-mono …` 逐字复制了三遍——改一处样式要记得改三处，而漏掉的那处不会报错、只会慢慢长歪。
 * 差异全部收敛成 columns 规格，表格骨架只有这一份。
 */
export function DebugTable<Row>({
  columns,
  rows,
  scroll = false,
  className,
}: {
  columns: DebugColumn<Row>[]
  rows: Row[]
  /** 行数不可控（调用栈）时给一个上限并允许内部滚动。 */
  scroll?: boolean
  className?: string
}) {
  const align = (a?: 'left' | 'center' | 'right') =>
    a === 'center' ? 'text-center' : a === 'right' ? 'text-right' : ''
  return (
    <div
      className={cn(
        'w-full rounded-lg bg-[var(--acr-field)]',
        scroll ? 'scrollbar-mac mt-1.5 max-h-[160px] overflow-y-auto' : 'mt-0.5 overflow-hidden',
        className
      )}
    >
      <Table className="w-full border-collapse font-mono text-[10px] leading-normal">
        <TableHeader
          className={cn(
            'border-b border-[var(--acr-border-soft)] bg-[var(--acr-field)]',
            // 滚动表的表头钉住：滚到第 40 帧还知道哪一列是哪一列。
            scroll && 'sticky top-0 z-10 backdrop-blur'
          )}
        >
          <TableRow className="h-6 border-b border-[var(--acr-border-soft)] hover:bg-transparent">
            {columns.map((c, i) => (
              <TableHead
                key={i}
                title={c.title}
                style={{ width: c.width }}
                className={cn('h-6 px-2 py-0.5 font-semibold text-muted-foreground', align(c.align))}
              >
                {c.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, r) => (
            <TableRow key={r} className="h-6 border-b border-[var(--acr-border-soft)] last:border-b-0 hover:bg-[var(--acr-hover)]">
              {columns.map((c, i) => (
                <TableCell key={i} className={cn('max-w-0 truncate px-2 py-1', align(c.align), c.className)}>
                  {c.cell(row)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
