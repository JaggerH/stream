import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor } from '@testing-library/react'
import { BackendProvider, useBackend } from './backend.tsx'
import * as api from './api.ts'

function Probe() {
  const b = useBackend()
  return (
    <div data-status={b.status} data-token={b.reloadToken} data-up={b.upstream}>
      {b.status}
    </div>
  )
}

describe('BackendProvider state machine', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.spyOn(api, 'applyBackend').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('没配上游 → 同源直接连上（不探测），bumps reloadToken', async () => {
    const probe = vi.fn(async () => false)
    render(
      <BackendProvider probe={probe}>
        <Probe />
      </BackendProvider>
    )
    await waitFor(() => expect(document.querySelector('[data-status="connected"]')).toBeTruthy())
    expect(api.applyBackend).toHaveBeenCalledWith('', '')
    expect(probe).not.toHaveBeenCalled()
    expect(document.querySelector('[data-token="1"]')).toBeTruthy()
  })

  it('配了上游且健康 → 直取它（HTTP 原样、WS 换 scheme）', async () => {
    const probe = vi.fn(async (u: string) => u === 'http://remote:9')
    render(
      <BackendProvider probe={probe} configuredUrl="http://remote:9">
        <Probe />
      </BackendProvider>
    )
    await waitFor(() => expect(document.querySelector('[data-status="connected"]')).toBeTruthy())
    expect(api.applyBackend).toHaveBeenCalledWith('http://remote:9', 'ws://remote:9')
    expect(document.querySelector('[data-up="http://remote:9"]')).toBeTruthy()
  })

  it('配的上游探不通 → 回落同源，仍然连上', async () => {
    const probe = vi.fn(async () => false)
    render(
      <BackendProvider probe={probe} configuredUrl="http://remote:9">
        <Probe />
      </BackendProvider>
    )
    await waitFor(() => expect(document.querySelector('[data-status="connected"]')).toBeTruthy())
    expect(probe).toHaveBeenCalledWith('http://remote:9')
    expect(api.applyBackend).toHaveBeenCalledWith('', '')
  })

  it('reportFailure drops to disconnected then re-aligns', async () => {
    const probe = vi.fn(async () => true)
    let ctx!: ReturnType<typeof useBackend>
    function Grab() {
      ctx = useBackend()
      return null
    }
    render(
      <BackendProvider probe={probe} backoffMs={10}>
        <Grab />
      </BackendProvider>
    )
    await waitFor(() => expect(ctx.status).toBe('connected'))
    const firstToken = ctx.reloadToken
    act(() => ctx.reportFailure())
    await waitFor(() => expect(ctx.reloadToken).toBeGreaterThan(firstToken))
  })

  it('reads stream.backend_url live on reconnect (Settings takes effect without restart) [H1]', async () => {
    // no configuredUrl prop → provider reads localStorage each ladder run
    const probed: string[] = []
    const probe = vi.fn(async (u: string) => {
      probed.push(u)
      return u === 'http://remote:9'
    })
    let ctx!: ReturnType<typeof useBackend>
    function Grab() {
      ctx = useBackend()
      return null
    }
    render(
      <BackendProvider probe={probe} backoffMs={5}>
        <Grab />
      </BackendProvider>
    )
    // first run: nothing configured → same-origin, nothing probed at all
    await waitFor(() => expect(ctx.status).toBe('connected'))
    expect(probed).toEqual([])
    // user sets a backend URL then reconnects
    window.localStorage.setItem('stream.backend_url', 'http://remote:9')
    act(() => ctx.reconnect())
    await waitFor(() => expect(ctx.upstream).toBe('http://remote:9'))
    expect(probed).toContain('http://remote:9') // the freshly-read config was probed first
  })
})
