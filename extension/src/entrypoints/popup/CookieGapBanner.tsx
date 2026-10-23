import { useEffect, useState } from 'react'
import { applyFix, fixPlan, readGaps, type FixPlan } from '../../lib/cookie-gaps.ts'
import { Button } from '@/components/acrylic/button.tsx'

/**
 * 「Stream 要读这些站点的登录态，这个 profile 还没允许」+ 一个「允许」（browser-identity 冒烟后续）。
 *
 * 缺口来自最近一轮后端来取登录态（`cookiePull`）时没给的域，见 lib/cookie-gaps.ts。同步范围与站点权限都按
 * profile 记，新 profile 里常常缺；面板的节点行上也会说，但只有这里点得动：站点权限只能由扩展在用户手势里要。
 * 没缺口时不画。修好之后叫 `onFixed`——上层让后台同步一轮，Stream 随即来取。
 */
export function CookieGapBanner({ onFixed }: { onFixed: () => void }) {
  const [plan, setPlan] = useState<FixPlan | null>(null)
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => {
    readGaps().then((g) => setPlan(fixPlan(g))).catch(() => setPlan(null))
  }, [])
  if (!plan || !plan.domains.length) return null

  const allow = () => {
    // 不能先 await 别的：permissions.request 只认这一下点击（applyFix 第一个调用就是它）。
    applyFix(plan)
      .then((ok) => {
        if (!ok) { setNote('没有允许，Stream 仍然读不到这些站点的登录态。'); return }
        setPlan(null)
        onFixed()
      })
      .catch((e) => setNote(String(e)))
  }

  return (
    <div className="flex flex-col gap-2 rounded-[9px] bg-[var(--acr-card-nested)] p-2.5">
      <p className="text-xs leading-relaxed text-[var(--acr-orange)]">
        Stream 要读这些站点的登录态，这个 profile 还没允许：{plan.domains.join('、')}
      </p>
      <Button size="small" variant="default" className="h-6 self-start" onClick={allow}>允许</Button>
      {note && <p className="text-[11px] text-muted-foreground">{note}</p>}
    </div>
  )
}
