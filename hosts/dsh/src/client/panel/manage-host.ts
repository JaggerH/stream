/**
 * 运维页（`panel-manage` bundle）的装载：把它挂进 DSH 设置里那个 Stream 分区给的容器。
 *
 * 它装的是**不属于任何一个频道**的那堆事：包/插件的安装启停、凭据、日志、更新，以及组件
 * （Provider）行。频道自己的配置已经回到频道里（各 Present 顶栏下的「配置」分页），这些全局
 * 的东西没有别的归属——DSH 的设置就是它们该在的地方，跟 DSH 自己的插件清单并列。
 *
 * 装载的那些坑（跨源 script、样式表生命周期、失败清理）全在 `asset-loader.ts` 里，与主面板
 * 共用同一份实现。
 */
import { createAssetLoader } from './asset-loader.ts'

interface ManageBundle {
  mount: (el: HTMLElement, opts: { backend: string }) => void
  unmount: () => void
}

const loader = createAssetLoader<ManageBundle>({
  file: 'panel-manage',
  // 与主面板的 `data-stream-panel` **必须不同**：同一个标记会让两者互相摘对方的样式表。
  marker: 'data-stream-manage',
  globalName: '__streamPanelManage',
  label: '运维页',
})

/**
 * 挂进宿主给的容器。
 * @param el - 宿主容器（设置分区里我们自己 appendChild 的那个 div）。
 * @param backend - Stream 后端的绝对地址。
 * @returns unmount（卸载 + 摘样式表；脚本单例保留复用）。
 */
export async function mountManageInto(el: HTMLElement, backend: string): Promise<{ unmount: () => void }> {
  loader.ensureStylesheet(backend)
  const api = await loader.load(backend)
  api.mount(el, { backend })
  return {
    unmount: () => {
      api.unmount()
      loader.removeStylesheet()
    },
  }
}
