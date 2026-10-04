import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { api, type Connection } from '../../lib/api.ts'
import type { RecipePackageSearchHit } from '../../lib/types.ts'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../acrylic/sheet.tsx'
import { DiscoverPanel } from '../recipes/DiscoverPanel.tsx'
import type { RecipePackageOps } from './useRecipePackageOps.ts'

/**
 * 「添加包」抽屉 —— 原来那个 `/recipes` 整页收成的一颗按钮。
 *
 * 为什么不是平级 tab：用户搜到一个包时的第一个问题是**「我是不是已经装了」**，
 * 分两页等于把这个判断拆到两屏。抽屉盖在包页上，关掉就看见自己刚装的东西落在哪一段。
 *
 * 装的动作本身不在这里 —— `RecipePackageOps` 是页级单例（preview 的防重复提交是全页闸门），
 * 确认框也挂在页上。这个组件只管**搜**。
 */
export function AddPackageSheet({
  open,
  onOpenChange,
  conn,
  ops,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  conn: Connection
  ops: RecipePackageOps
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [hasSearched, setHasSearched] = useState(false)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<RecipePackageSearchHit[]>([])

  const runSearch = async () => {
    // 硬闸：连敲两次回车（onKeyDown 不看 searching，只有搜索按钮 disabled）会并发两次
    // registry 请求，后到先得的 setResults 可能把旧关键词的结果留在屏上。
    if (searching) return
    const q = query.trim()
    if (!q) return
    setHasSearched(true)
    setError(null)
    setResults([])
    setSearching(true)
    try {
      setResults(await api.searchRecipePackages(conn, q))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSearching(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[min(560px,92vw)] sm:max-w-none">
        <SheetHeader>
          <SheetTitle>{t('packages.addTitle')}</SheetTitle>
          <SheetDescription>{t('packages.addBody')}</SheetDescription>
        </SheetHeader>
        <div className="scrollbar-mac flex-1 overflow-y-auto px-4 pb-4">
          <DiscoverPanel
            query={query}
            onQueryChange={setQuery}
            onSubmit={() => void runSearch()}
            hasSearched={hasSearched}
            searching={searching}
            error={error}
            results={results}
            pendingName={ops.pendingName}
            onInstall={(name, version) => ops.startPreview(name, version)}
          />
        </div>
      </SheetContent>
    </Sheet>
  )
}
