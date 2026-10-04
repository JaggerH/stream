import type { ChromeCandidate } from './discover-chrome.ts'

/**
 * 「采集用哪个 Chrome」的选择面（spec §4）。
 *
 * WSL 和 Windows 都装了 Chrome 是合法状态，而**选错的后果很重且很隐蔽**：选了 Linux 侧那个，
 * 采集全程游客态，但一切"正常运行"，只是采不到东西。所以这里的产物是「候选清单 + 当前选择 +
 * 要不要问用户」，**发现与选择分开**：discoverChromeCandidates 只列，选择永远来自用户。
 */
export interface HarvestBrowserStatus {
  /** 当前生效的 exe 绝对路径；从没选过 → null */
  selected: string | null
  /** 这个选择是从哪来的：settings 覆盖层 / config.yaml / 没有 */
  origin: 'settings' | 'config' | null
  /** 这台机器上发现的全部候选，Windows 侧在前（只是排序，不是自动选中） */
  candidates: ChromeCandidate[]
  /** 入口该不该停下来问用户：没选过 且 候选不止一个 */
  mustChoose: boolean
}

export function harvestBrowserStatus(opts: {
  settingsExe?: string
  configExe?: string
  candidates: ChromeCandidate[]
}): HarvestBrowserStatus {
  const settings = opts.settingsExe?.trim()
  const config = opts.configExe?.trim()
  const selected = settings || config || null
  const origin = settings ? 'settings' : config ? 'config' : null
  return {
    selected,
    origin,
    candidates: opts.candidates,
    // 只有一个候选时不打扰（没有可选错的余地）；一个都没有时问也没用——那是"装 Chrome"的引导，
    // 不是"选哪个"。用户已经选过的一律不再问，哪怕候选里没有它（自定义安装路径是合法的）。
    mustChoose: !selected && opts.candidates.length > 1,
  }
}
