import { beforeEach, describe, it, expect, vi } from 'vitest'
import type { ReactElement } from 'react'
import { render, screen } from '@testing-library/react'
import { Navbar } from '../components/Navbar.tsx'
import { ScrollArea } from '../components/ui/scroll-area.tsx'
import {
  SidebarMenuSubButton,
  SidebarInset,
  SidebarProvider,
} from '../components/acrylic/sidebar.tsx'
import { LabelSelect } from '../components/LabelSelect.tsx'
import { VideoStageContext, type VideoStage } from '../lib/videoStage.ts'
import { AudioStageContext, type AudioStage } from '../lib/audioStage.ts'
import type { Item } from '../lib/types.ts'
import { EventsProvider } from '../components/EventsProvider.tsx'
import * as transport from '../lib/transport.ts'

// Navbar mounts NotificationBell → EventsProvider → useWs → selectTransport().openSocket;
// jsdom's WebSocket rejects the app's relative '/ws' url (no real backend in unit tests),
// so stub the transport the same way useWs.test.tsx does.
// **在 beforeEach 里建，不是模块级**：`restoreMocks` 每个测试后还原全部 spy（见 vite.config.ts），
// 模块级只建一次的 spy 会在第一个测试跑完后消失，之后每条都去打真的 WebSocket。
beforeEach(() => {
  vi.spyOn(transport, 'selectTransport').mockReturnValue({
    fetch: vi.fn(),
    openSocket: vi.fn(() => ({ send: vi.fn(), close: vi.fn() })),
  })
})

// a card Row reads the shared video + audio stages; provide inert ones for rendering.
const videoStage: VideoStage = { activeId: null, openId: null, node: null, videoSize: null, play: () => {}, stop: () => {}, seek: () => {} }
const audioStage: AudioStage = { current: null, playing: false, duration: 0, activeKind: 'music', queues: { music: [], podcast: [] }, queue: [], play: () => {}, playQueue: () => {}, playAt: () => {}, toggle: () => {}, seek: () => {}, stop: () => {}, getVolume: () => 1, setVolume: () => {} }
// Navbar now mounts NotificationBell, which reads useEvents() — wrap with the real
// provider (its WS attempt no-ops harmlessly in jsdom without a backend).
const renderInStages = (ui: ReactElement) =>
  render(
    <EventsProvider>
      <AudioStageContext.Provider value={audioStage}>
        <VideoStageContext.Provider value={videoStage}>{ui}</VideoStageContext.Provider>
      </AudioStageContext.Provider>
    </EventsProvider>
  )

describe('ScrollArea', () => {
  it('reserves inline-end content space for the overlay vertical scrollbar', () => {
    const { container } = render(
      <ScrollArea className="h-40 scrollbar-mac">
        <div>Wide content</div>
      </ScrollArea>
    )

    const viewport = container.querySelector('[data-radix-scroll-area-viewport]')
    expect(viewport?.className).toContain('pr-2.5')
  })
})

describe('Acrylic sidebar menu', () => {
  it('truncates nested submenu titles by default', () => {
    const { container } = render(
      <SidebarProvider>
        <SidebarMenuSubButton asChild>
          <button type="button">
            <span data-testid="label-wrap" className="grid">
              <span data-testid="label-title">A very long source title that should never widen the sidebar structure</span>
              <span>Subtitle</span>
            </span>
          </button>
        </SidebarMenuSubButton>
      </SidebarProvider>
    )

    const buttonClass = container.querySelector('[data-slot="sidebar-menu-sub-button"]')?.className ?? ''
    expect(buttonClass).toContain('min-w-0')
    expect(buttonClass).toContain('[&>span:not([data-slot=avatar])]:overflow-hidden')
    expect(buttonClass).toContain('[&>span:not([data-slot=avatar])]:[mask-image:linear-gradient')
  })
})

describe('LabelSelect', () => {
  const conn = { baseUrl: 'http://x' }
  const base: Item = { id: 'p1', stream_id: 'hn', type: 'post', title: 'an ad?', timestamp: '', fetched_at: '' }

  it('renders the manual-label control with a placeholder for an unlabeled item', () => {
    render(<LabelSelect item={base} conn={conn} />)
    expect(screen.getByText('标注')).toBeDefined()
    expect(screen.getByRole('combobox')).toBeDefined()
  })

  it('renders without crashing for an already-labeled item', () => {
    render(<LabelSelect item={{ ...base, muted: { reason: 'lottery', rule: 'manual', manual: true } }} conn={conn} />)
    expect(screen.getByRole('combobox')).toBeDefined()
  })
})

describe('Navbar', () => {
  it('renders the Stream brand', () => {
    // Navbar uses useAudioStage() for its now-playing mini-control, so it must
    // render inside an AudioStage provider (the inert stage → widget renders null).
    renderInStages(
      <SidebarProvider>
        <Navbar
          query=""
          onQuery={() => {}}
          onOpenSettings={() => {}}
        />
      </SidebarProvider>
    )
    expect(screen.getByPlaceholderText('过滤消息… ⏎ 跨平台搜索')).toBeDefined()
  })

  it('stays inside the sidebar inset shell', () => {
    const { container } = renderInStages(
      <SidebarProvider>
        <SidebarInset>
          <Navbar
            query=""
            onQuery={() => {}}
            onOpenSettings={() => {}}
          />
        </SidebarInset>
      </SidebarProvider>
    )
    const search = screen.getByPlaceholderText('过滤消息… ⏎ 跨平台搜索')
    expect(container.querySelector('[data-slot="sidebar-inset"]')?.contains(search)).toBe(true)
  })
})
