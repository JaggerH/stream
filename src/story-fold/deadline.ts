/**
 * 「等一个可能永远不回来的外部调用，到点就当它不存在」。
 *
 * 折叠的第 2、3 档各自等一件外部的事（抓正文、问模型），两档的处置完全一样：**到点不等了，
 * 但不取消上游**——它跑完自己会结束，取消也退不回已经花掉的那次。规则一分家就会有一处忘了
 * 它其实等得起整条搜索热路径。
 */
export function withDeadline<T>(p: Promise<T>, ms: number, onExpire: () => void): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      onExpire()
      resolve(null)
    }, ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      },
    )
  })
}
