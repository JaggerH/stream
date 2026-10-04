import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { api, type Connection } from '../../lib/api.ts'
import type { RecipePackagePreview } from '../../lib/types.ts'
import { toast } from '../acrylic/sonner.tsx'

/**
 * 装 / 卸 / 升级一个 recipe 包的那套操作，**一份实现两处用**：包页的行内 ··· 菜单，和
 * 「添加包」抽屉里搜到的结果。
 *
 * 分两份写会分家的正是这里最要紧的那道闸：`preview` 是一次**真实的整包下载 + 全套门禁**
 * （白名单 / schema / 穿越 / 三道限额 / integrity），慢网络下数秒。防重复提交必须在
 * **同一 tick 内**生效，等 React 把 state 刷回来就晚了——所以是 ref 不是 state。
 * 全页单例：A 行的 preview 在飞时 B 行也不能开一个。
 *
 * `confirm` 只能来自 preview（tarball integrity），不匹配后端会拒——所以「更新」也必须
 * 先 preview，不能直接 install。
 */
export interface RecipePackageOps {
  /** 正在 preview 的那个包名（全页至多一个）。用来给发起的那一行一个进行中反馈。 */
  pendingName: string | null
  /** 正在卸载的那个包名。 */
  busyName: string | null
  /** preview 回来之后待确认的那一份；渲染确认框的地方读它。 */
  preview: RecipePackagePreview | null
  installing: boolean
  installError: string | null
  /** 下载 + 跑门禁，成功后弹确认框。同一时刻只允许一次。 */
  startPreview: (name: string, version?: string) => void
  install: (p: RecipePackagePreview) => void
  uninstall: (name: string) => void
  cancelPreview: () => void
}

export function useRecipePackageOps(conn: Connection, onChanged: () => void | Promise<void>): RecipePackageOps {
  const { t } = useTranslation()
  const [pendingName, setPendingName] = useState<string | null>(null)
  const pendingRef = useRef<string | null>(null)
  const [busyName, setBusyName] = useState<string | null>(null)
  const [preview, setPreview] = useState<RecipePackagePreview | null>(null)
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)

  const startPreview = useCallback((name: string, version?: string) => {
    if (pendingRef.current) return
    pendingRef.current = name
    setPendingName(name)
    setInstallError(null)
    void (async () => {
      try {
        setPreview(await api.previewRecipePackage(conn, name, version))
      } catch (err) {
        // 门禁的拒绝理由是写给人看的（「files outside the whitelist: evil.js」）。
        // 包装成笼统的「安装失败」等于把最有用的信息扔掉。
        toast.error(err instanceof Error ? err.message : String(err))
      } finally {
        pendingRef.current = null
        setPendingName(null)
      }
    })()
  }, [conn])

  const install = useCallback((p: RecipePackagePreview) => {
    setInstalling(true)
    setInstallError(null)
    void (async () => {
      try {
        await api.installRecipePackage(conn, p.name, p.version, p.confirm)
        setPreview(null)
        toast.success(t('recipes.installedToast', { name: p.name }))
        await onChanged()
      } catch (err) {
        // 失败留在对话框里报后端原话：confirm token mismatch 这类错的唯一正解是重新 preview，
        // 而对话框正是用户能立刻重来的地方。
        setInstallError(err instanceof Error ? err.message : String(err))
      } finally {
        setInstalling(false)
      }
    })()
  }, [conn, onChanged, t])

  const uninstall = useCallback((name: string) => {
    setBusyName(name)
    void (async () => {
      try {
        await api.uninstallRecipePackage(conn, name)
        toast.success(t('recipes.uninstalledToast', { name }))
        await onChanged()
      } catch (err) {
        // 失败就保持原状：不刷新列表，只报原因。
        toast.error(err instanceof Error ? err.message : String(err))
      } finally {
        // 成功/失败都要落这一步：漏了它那一行会永久禁用。
        setBusyName(null)
      }
    })()
  }, [conn, onChanged, t])

  const cancelPreview = useCallback(() => { setPreview(null); setInstallError(null) }, [])

  return { pendingName, busyName, preview, installing, installError, startPreview, install, uninstall, cancelPreview }
}
