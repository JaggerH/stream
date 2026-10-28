// deploymentFromEnv：环境变量 → AppConfig.deployment 的唯一翻译处。新键（任务 5 收进来的那批）
// 在这里钉住：缺省值、精确开关、透传。
import { describe, expect, it } from 'vitest'
import { deploymentFromEnv } from './bootstrap.ts'

const env = (over: Record<string, string> = {}) => over as NodeJS.ProcessEnv

describe('deploymentFromEnv（收编后的全量键）', () => {
  it('缺省：开关全开、地址类缺省缺', () => {
    const d = deploymentFromEnv(env())
    expect(d.scheduler).toBe(true)
    expect(d.recipe_update_check).toBe(true)
    expect(d.desktop_see_trace).toBeUndefined()
    expect(d.desktop_status).toBe(true)
    expect(d.recipe_probe).toBe(true)
    expect(d.plugin_network).toBe('none')
    expect(d.mineru_url).toBeUndefined()
    expect(d.npm_registry).toBeUndefined()
    expect(d.docker_host).toBeUndefined()
    expect(d.rsshub_pkg).toBeUndefined()
    expect(d.workbuddy_helper_url).toBeUndefined()
  })

  it('开关与地址逐键翻译', () => {
    const d = deploymentFromEnv(env({
      STREAM_NO_SCHEDULER: '1',
      STREAM_RECIPE_UPDATE_CHECK: '0',
      STREAM_DESKTOP_SEE_TRACE: '1',
      STREAM_DESKTOP_STATUS: '0',
      RECIPE_PROBE: '0',
      STREAM_PLUGIN_NETWORK: 'compose',
      MINERU_URL: 'https://mineru.example/',
      STREAM_NPM_REGISTRY: 'https://mirror.example',
      DOCKER_HOST: 'unix:///run/docker.sock',
      RSSHUB_PKG: '/x/rsshub/lib/pkg.ts',
      STREAM_WORKBUDDY_HELPER_URL: 'http://127.0.0.1:18081',
    }))
    expect(d.scheduler).toBe(false)
    expect(d.recipe_update_check).toBe(false)
    expect(d.desktop_see_trace).toBe(true)
    expect(d.desktop_status).toBe(false)
    expect(d.recipe_probe).toBe(false)
    expect(d.plugin_network).toBe('compose')
    expect(d.mineru_url).toBe('https://mineru.example/')
    expect(d.npm_registry).toBe('https://mirror.example')
    expect(d.docker_host).toBe('unix:///run/docker.sock')
    expect(d.rsshub_pkg).toBe('/x/rsshub/lib/pkg.ts')
    expect(d.workbuddy_helper_url).toBe('http://127.0.0.1:18081')
  })
})
