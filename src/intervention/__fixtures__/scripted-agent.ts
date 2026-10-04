import * as acp from '@agentclientprotocol/sdk'
import { openAcpClient, type AcpHandlers, type SpawnedAgent } from '../acp-client.ts'

/**
 * 两份会话测试（repair / explore）共用的进程内假 agent。**一份，不是两份**：两边各抄一遍的话，
 * 基类改了行为只有一边的夹具会跟上，而另一边照样全绿——绿得毫无意义。
 */

/** 可编程假 agent：每次 prompt 按脚本走一步。 */
export type Turn = (cx: {
  sessionId: string
  text: string
  notify: (u: acp.SessionUpdate) => Promise<void>
  ask: (tc: acp.ToolCallUpdate, options?: acp.PermissionOption[]) => Promise<acp.RequestPermissionResponse>
  cwd: string
}) => Promise<acp.PromptResponse>

export interface ScriptedAgent {
  app: acp.AgentApp
  cwd: () => string
  loaded: () => boolean
  servers: () => unknown
}

export function scriptedAgent(
  turns: Turn[],
  opts: { loadSession?: boolean; onLoad?: (cx: { sessionId: string; notify: (u: acp.SessionUpdate) => Promise<void> }) => Promise<void> } = {},
): ScriptedAgent {
  let i = 0
  let cwd = ''
  let loaded = false
  let servers: unknown
  const app = acp.agent({ name: 'scripted' })
    .onRequest(acp.methods.agent.initialize, async () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: opts.loadSession ?? true },
    }))
    .onRequest(acp.methods.agent.session.new, async (cx) => { cwd = cx.params.cwd; servers = cx.params.mcpServers; return { sessionId: 'S1' } })
    .onRequest(acp.methods.agent.session.load, async (cx) => {
      cwd = cx.params.cwd
      servers = cx.params.mcpServers
      loaded = true
      await opts.onLoad?.({
        sessionId: cx.params.sessionId,
        notify: (update) => cx.client.notify(acp.methods.client.session.update, { sessionId: cx.params.sessionId, update }),
      })
      return {}
    })
    .onNotification(acp.methods.agent.session.cancel, async () => {})
    .onRequest(acp.methods.agent.session.prompt, async (cx) => {
      const turn = turns[Math.min(i++, turns.length - 1)]!
      const text = cx.params.prompt.map((b) => (b.type === 'text' ? b.text : '')).join('')
      return turn({
        sessionId: cx.params.sessionId,
        text,
        cwd,
        notify: (update) => cx.client.notify(acp.methods.client.session.update, { sessionId: cx.params.sessionId, update }),
        ask: (toolCall, options) => cx.client.request(acp.methods.client.session.requestPermission, {
          sessionId: cx.params.sessionId,
          toolCall,
          options: options ?? [
            { optionId: 'y', name: 'ok', kind: 'allow_once' },
            { optionId: 'n', name: 'no', kind: 'reject_once' },
          ],
        }),
      })
    })
  return { app, cwd: () => cwd, loaded: () => loaded, servers: () => servers }
}

/** 把一个假 agent 包成 `SpawnedAgent`（进程内，没有真子进程，所以 exited 永远不落地）。 */
export const inProcess = (app: acp.AgentApp) => (_cmd: unknown, handlers: AcpHandlers): SpawnedAgent => ({
  ...openAcpClient(app, handlers),
  exited: new Promise(() => {}),
  kill: () => {},
})
