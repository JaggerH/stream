import { useTranslation } from 'react-i18next'
import { SearchIcon } from 'lucide-react'
import { isValidPackageName } from '@recipe-market/package-name.ts'
import { Button } from '../acrylic/button.tsx'
import { InputGroup, InputGroupInput } from '../acrylic/input-group.tsx'
import type { RecipePackageSearchHit } from '../../lib/types.ts'

/** 发现区：一个输入框同时承担两种意图。
 *   - 输入形如包名（`@scope/name` 或裸包名）→ 结果区直接给出「安装 <包名>」这一条。
 *     **不设第二个输入框**：两种意图在同一个输入行为里，两个框是把机制暴露给用户。
 *     这也是 npm 搜索索引滞后的出路——搜不到刚发布的包时，把包名整个粘进来即可。
 *   - 否则按关键词打搜索代理，**提交触发**（回车 / 点按钮），不做输入即搜：每次搜索是一次
 *     真实 registry 网络往返。
 *  判「是不是包名」用的是 shared/recipe-market 那一份文法——与后端安装门同一把尺。 */
export function DiscoverPanel({
  query,
  onQueryChange,
  onSubmit,
  hasSearched,
  searching,
  error,
  results,
  pendingName,
  onInstall,
}: {
  query: string
  onQueryChange: (q: string) => void
  onSubmit: () => void
  hasSearched: boolean
  searching: boolean
  error: string | null
  results: RecipePackageSearchHit[]
  pendingName: string | null
  onInstall: (name: string, version?: string) => void
}) {
  const { t } = useTranslation()
  const trimmed = query.trim()
  const directName = isValidPackageName(trimmed) ? trimmed : null
  // scoped 包名（`@scope/name`）唯一合法形状里 `/` 只跟在 `@scope` 后面，所以
  // "是 scoped 包名" 与 "startsWith('@')" 等价——比读 `.includes('/')` 再倒推一层
  // 正则保证更直给。
  const isScopedName = directName?.startsWith('@') ?? false

  const installLabel = (name: string, label: string) =>
    pendingName === name ? t('recipes.previewing') : label

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <InputGroup className="flex-1">
          <InputGroupInput
            placeholder={t('recipes.searchPlaceholder')}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') onSubmit() }}
          />
        </InputGroup>
        <Button variant="neutral" size="medium" disabled={searching} onClick={onSubmit}>
          <SearchIcon />
          {searching ? t('recipes.searching') : t('recipes.search')}
        </Button>
      </div>

      {directName ? (
        <div className="flex items-center gap-3 rounded-md border p-2 text-[12px]">
          <strong className="flex-1 truncate">{directName}</strong>
          {/* pendingName 非空时禁用**每一个**安装按钮（不只当前这个），不是单条目自锁——
              防止在一个包的安装还没落定时，用户又点了另一个包，两次安装互相打架。 */}
          <Button
            variant="default"
            size="small"
            disabled={pendingName !== null}
            onClick={() => onInstall(directName)}
          >
            {installLabel(directName, t('recipes.installDirect', { name: directName }))}
          </Button>
        </div>
      ) : null}

      {error ? <p className="text-[12px] text-destructive">{error}</p> : null}

      <ul className="flex flex-col gap-2">
        {results.map((hit) => (
          <li key={hit.name} className="flex items-center gap-3 rounded-md border p-2 text-[12px]">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <strong className="truncate">{hit.name}</strong>
                <span className="text-muted-foreground">{hit.version}</span>
              </div>
              {hit.description ? <span className="truncate text-muted-foreground">{hit.description}</span> : null}
            </div>
            <Button
              variant="default"
              size="small"
              disabled={pendingName !== null}
              onClick={() => onInstall(hit.name)}
            >
              {installLabel(hit.name, t('recipes.install'))}
            </Button>
          </li>
        ))}
      </ul>

      {hasSearched && !searching && !error && results.length === 0 && !isScopedName ? (
        <p className="text-[12px] text-muted-foreground">{t('recipes.searchEmptyHint')}</p>
      ) : null}
    </div>
  )
}
