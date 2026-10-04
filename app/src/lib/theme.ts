// App theme (light / dark / acrylic): stored value + <html> class application.
// Single source of truth for the boot-time init and the runtime switcher in
// components/ThemeSegmentedControl.tsx.

export const THEME_STORAGE_KEY = 'stream.theme'
export const APP_THEME_VALUES = ['light', 'dark', 'acrylic'] as const
export type AppThemeValue = (typeof APP_THEME_VALUES)[number]

export function readStoredTheme(): AppThemeValue {
  if (typeof window === 'undefined') return 'acrylic'
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
  return APP_THEME_VALUES.includes(stored as AppThemeValue) ? (stored as AppThemeValue) : 'acrylic'
}

/** 三档应用主题 → 两档视图主题（图表用它取背景 / 坐标轴 / 文字色）。
 *  `acrylic` 归到 `light`：毛玻璃底是偏亮的，按暗色配色画的图表嵌在里面会整块发黑。
 *  不跟随系统 `prefers-color-scheme`——判据只有存储值这一个，页面和图表才不会各说各话。 */
export function appThemeToViewTheme(theme: AppThemeValue): 'light' | 'dark' {
  return theme === 'dark' ? 'dark' : 'light'
}

/** Swap the <html> theme class without persisting — used by the boot init. */
export function applyThemeClass(theme: AppThemeValue) {
  document.documentElement.classList.remove(...APP_THEME_VALUES)
  document.documentElement.classList.add(theme)
}

export function applyAppTheme(theme: AppThemeValue) {
  applyThemeClass(theme)
  window.localStorage.setItem(THEME_STORAGE_KEY, theme)
}
