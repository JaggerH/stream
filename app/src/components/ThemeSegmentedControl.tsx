// Sidebar-footer theme switcher: the real 3-way Light / Dark / Acrylic control.
import { useEffect, useState } from 'react'
import { DropletIcon, MoonIcon, SunIcon } from 'lucide-react'

import { applyAppTheme, readStoredTheme, type AppThemeValue } from '../lib/theme.ts'
import { ButtonGroup, ButtonGroupItem } from './acrylic/button-group.tsx'

const APP_THEMES = [
  { value: 'light', label: 'Light', icon: SunIcon },
  { value: 'dark', label: 'Dark', icon: MoonIcon },
  { value: 'acrylic', label: 'Acrylic', icon: DropletIcon },
] as const

export function ThemeSegmentedControl() {
  const [theme, setTheme] = useState<AppThemeValue>(() => readStoredTheme())

  useEffect(() => {
    applyAppTheme(theme)
  }, [theme])

  return (
    <ButtonGroup
      data-slot="theme-segmented-control"
      variant="segmented"
      size="small"
      value={theme}
      onValueChange={(value) => setTheme(value as AppThemeValue)}
      aria-label="Theme"
      className="shrink-0 group-data-[collapsible=icon]:hidden"
    >
      {APP_THEMES.map(({ value, label, icon: Icon }) => (
        <ButtonGroupItem
          key={value}
          value={value}
          aria-label={label}
          title={label}
        >
          <Icon />
        </ButtonGroupItem>
      ))}
    </ButtonGroup>
  )
}
