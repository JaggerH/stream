/**
 * 浏览器视口坐标 → 屏幕绝对坐标。
 *
 * 「用 OS 级输入(Stream Desktop 的 enigo)去点浏览器里的一个元素」缺的就是这一环:CDP 读得到元素
 * 在**视口**里的位置(`getBoundingClientRect`),而 enigo 要的是**屏幕**绝对坐标。
 *
 * 为什么不去算窗口几何(`screenX + (outerHeight-innerHeight) + rect` 再乘 `devicePixelRatio`):
 * 那要同时猜对工具栏高度、窗口边框、以及 DPR 在各处的应用方式——正是 125%/150% 显示缩放下会偏的
 * 做法(`docs/TODO.md` 桌面自动化那条记的「坐标/DPR 校准」)。
 *
 * 改成**自标定**:把鼠标挪到两个已知屏幕点,页面上的 `mousemove` 报回它看到的 `clientX/clientY`,
 * 两点解出这个仿射映射。DPR、工具栏高度、窗口边框一个都不用知道——它们全被吸收进 offset/scale。
 * 窗口一移动或缩放,重标一次即可。
 */

export interface Point {
  x: number
  y: number
}

/** 一次标定采样:鼠标被放到 `screen`,页面报告它落在视口的 `viewport`。 */
export interface CalibrationProbe {
  screen: Point
  viewport: Point
}

/** screen = offset + viewport * scale（每轴独立解，但两轴应当一致——见 solve 的校验）。 */
export interface ScreenMapping {
  offsetX: number
  offsetY: number
  scaleX: number
  scaleY: number
}

/** 两轴缩放允许的相对差。真实显示缩放是各向同性的；差超过这个说明采样坏了。 */
const SCALE_SKEW_TOLERANCE = 0.05

/**
 * 从标定采样解出映射。取首尾两点(跨度最大 → 数值最稳)。
 * 解不出来就抛——**绝不返回一个含 Infinity/NaN 的映射**，那会让 enigo 点到屏幕外。
 */
export function solveScreenMapping(probes: CalibrationProbe[]): ScreenMapping {
  if (probes.length < 2) throw new Error('屏幕坐标标定至少需要两个采样点 (need at least two probes)')
  const a = probes[0]
  const b = probes[probes.length - 1]
  const dvx = b.viewport.x - a.viewport.x
  const dvy = b.viewport.y - a.viewport.y
  if (dvx === 0) throw new Error('标定失败：两个采样点的视口 x 相同，x 轴解不出缩放')
  if (dvy === 0) throw new Error('标定失败：两个采样点的视口 y 相同，y 轴解不出缩放')

  const scaleX = (b.screen.x - a.screen.x) / dvx
  const scaleY = (b.screen.y - a.screen.y) / dvy
  const skew = Math.abs(scaleX - scaleY) / Math.max(Math.abs(scaleX), Math.abs(scaleY))
  if (skew > SCALE_SKEW_TOLERANCE) {
    throw new Error(
      `标定失败：两轴缩放不一致 (scaleX=${scaleX.toFixed(3)} scaleY=${scaleY.toFixed(3)})——` +
        `显示缩放应当各向同性，采样不可信，不能拿它去点`,
    )
  }
  return {
    scaleX,
    scaleY,
    offsetX: a.screen.x - a.viewport.x * scaleX,
    offsetY: a.screen.y - a.viewport.y * scaleY,
  }
}

/** 视口点 → 屏幕点。取整——enigo 吃的是整数像素。 */
export function toScreenPoint(m: ScreenMapping, viewport: Point): Point {
  return {
    x: Math.round(m.offsetX + viewport.x * m.scaleX),
    y: Math.round(m.offsetY + viewport.y * m.scaleY),
  }
}
