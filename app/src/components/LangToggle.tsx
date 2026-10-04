import { useTranslation } from 'react-i18next'
import { cn } from '../lib/utils.ts'

/** Compact zh/EN language switch. Persists via i18next's localStorage cache. */
export function LangToggle({ className }: { className?: string }) {
  const { i18n } = useTranslation()
  const isZh = i18n.language?.startsWith('zh') ?? true
  return (
    <button
      onClick={() => i18n.changeLanguage(isZh ? 'en' : 'zh')}
      title="Language / 语言"
      aria-label="Toggle language"
      className={cn(
        'p-2 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors',
        className
      )}
    >
      {isZh ? 'EN' : '中'}
    </button>
  )
}
