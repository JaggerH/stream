import { readdirSync, watch } from 'node:fs'
import { join } from 'node:path'

/** 一棵目录树的文件监听。**刻意不用 `fs.watch({recursive:true})`。**
 *
 *  Node 在 Linux 上的递归监听不是内核原生能力，是 JS 层自己按目录模拟的；在这台机器
 *  （WSL2）上它撑不住。三档并排实测（同一进程、同一目录、每 2.5s 改一次、共 12 轮）：
 *
 *    recursive:true  + persistent:false  → 只有前 2 轮收到事件
 *    recursive:true  + persistent:true   → 同样只有前 2 轮      ← 和 GC / persistent 无关
 *    非 recursive                         → 12/12 全中
 *
 *  失效方式是**彻底静默**：不报错、不发事件、也没有任何一处会亮。所以别再把
 *  `recursive:true` 请回来——它会让「改了配置没反应」这个现象重新出现，而现场看起来
 *  跟「你自己写错了」一模一样。
 *
 *  代价是新目录要自己补挂：任何一次事件之后重新走一遍树，多出来的挂上、没了的收掉。
 *  走树只是 readdir，几十个目录的量级可以忽略；真正重的重装由调用方 debounce。 */
export interface WatchTreeDeps {
  /** 列出该目录下的子目录绝对路径；目录不存在就抛。 */
  listDirs(dir: string): string[]
  watch(dir: string, onEvent: () => void): { close(): void }
}

const nodeDeps: WatchTreeDeps = {
  listDirs: (dir) =>
    readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(dir, e.name)),
  // persistent:false —— 监听不该拖住进程退出。句柄由下面的 Map 持有。
  watch: (dir, onEvent) => watch(dir, { persistent: false }, () => onEvent()),
}

export function watchTree(
  roots: string[],
  onChange: () => void,
  deps: WatchTreeDeps = nodeDeps
): { close(): void } {
  const watchers = new Map<string, { close(): void }>()

  const sync = () => {
    const wanted = new Set<string>()
    // 先列再登记：列不出来的目录（不存在 / 刚被删）压根不该被挂上。
    // 一个子目录塌了也只丢它自己那一支，不牵连同根的其他分支。
    const walk = (dir: string) => {
      let children: string[]
      try {
        children = deps.listDirs(dir)
      } catch {
        return
      }
      wanted.add(dir)
      for (const child of children) walk(child)
    }
    for (const root of roots) walk(root)
    for (const [dir, w] of [...watchers]) {
      if (!wanted.has(dir)) {
        w.close()
        watchers.delete(dir)
      }
    }
    for (const dir of wanted) {
      if (watchers.has(dir)) continue
      try {
        watchers.set(dir, deps.watch(dir, () => { sync(); onChange() }))
      } catch {
        /* 刚被删掉之类——下一次事件再补 */
      }
    }
  }

  sync()
  return {
    close() {
      for (const w of watchers.values()) w.close()
      watchers.clear()
    },
  }
}
