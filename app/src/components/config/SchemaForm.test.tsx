import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import Schema from 'schemastery'
import { SchemaForm } from './SchemaForm.tsx'
import type { Connection } from '../../lib/api.ts'

const conn = { baseUrl: 'http://test.local' } as Connection

// 服务端形状：schemastery toJSON（refs 形式）。这里用真 schemastery 生成，
// 钉的是「序列化 → 复原 → 渲染」整条链，不是手搓一份假 JSON。
const demoSchema = Schema.object({
  apiKey: Schema.string().role('secret').description('TMDb API Key'),
  language: Schema.string().default('zh-CN').description('元数据语言'),
})

function mockFetch(status: { values: Record<string, unknown>; secrets: Record<string, { configured: boolean }> }) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(
        JSON.stringify({ schema: JSON.parse(JSON.stringify(demoSchema.toJSON())), ...status }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })
  )
  return calls
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('SchemaForm', () => {
  it('从服务端 schema 渲染字段：密文是 password 框带「已配置」占位，普通字段回显值', async () => {
    mockFetch({ values: { language: 'en-US' }, secrets: { apiKey: { configured: true } } })
    render(<SchemaForm conn={conn} rowId="video-sources" />)
    const secretInput = await screen.findByLabelText(/TMDb API Key/)
    expect(secretInput.getAttribute('type')).toBe('password')
    expect(secretInput.getAttribute('placeholder')).toBe('••••••••')
    expect(screen.getByText(/留空保持不变/)).toBeTruthy()
    expect((screen.getByLabelText(/元数据语言/) as HTMLInputElement).value).toBe('en-US')
  })

  it('保存把草稿 PUT 到 /api/config/:rowId；没动过的密文字段不发（缺席=保留，判据在后端）', async () => {
    const calls = mockFetch({ values: { language: 'zh-CN' }, secrets: { apiKey: { configured: true } } })
    render(<SchemaForm conn={conn} rowId="video-sources" />)
    const lang = await screen.findByLabelText(/元数据语言/)
    fireEvent.change(lang, { target: { value: 'ja-JP' } })
    fireEvent.click(screen.getByRole('button', { name: /保存/ }))
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'PUT')).toBe(true))
    const putCall = calls.find((c) => c.init?.method === 'PUT')!
    expect(putCall.url).toBe('http://test.local/api/config/video-sources')
    expect(JSON.parse(putCall.init!.body as string)).toEqual({ language: 'ja-JP' })
  })

  it('PUT 400 时把后端的错误原文亮在表单顶部', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          return new Response(JSON.stringify({ error: 'no such executable: /bad' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response(
          JSON.stringify({ schema: JSON.parse(JSON.stringify(demoSchema.toJSON())), values: {}, secrets: { apiKey: { configured: false } } }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      })
    )
    render(<SchemaForm conn={conn} rowId="video-sources" />)
    fireEvent.click(await screen.findByRole('button', { name: /保存/ }))
    expect(await screen.findByText(/no such executable/)).toBeTruthy()
  })
})
