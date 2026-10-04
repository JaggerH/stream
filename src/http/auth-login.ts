import type { WsHub } from './ws.ts'
import type { LoginEvent } from '../auth/login-provider.ts'

interface LoginStartCommand {
  type: 'login-start'
  facility: string
}

export interface AuthLoginDeps {
  /** run the facility's declared login provider; each event is bridged to the WS by this helper */
  startLogin(facility: string, emit: (e: LoginEvent) => void): Promise<void>
}

function parseStart(value: unknown): LoginStartCommand | null {
  const v = value as Partial<LoginStartCommand> | null
  if (!v || v.type !== 'login-start' || typeof v.facility !== 'string' || !v.facility || v.facility.length > 128) return null
  return v as LoginStartCommand
}

/**
 * Bridge a frontend `login-start` command to the backend login provider. Each provider
 * event is broadcast to EVERY client as `login-<kind>` (single-user app — any open panel
 * should see the QR / result), and a thrown startLogin rejects into a terminal `login-failed`
 * so the panel never hangs waiting.
 */
export function attachAuthLoginCommands(hub: WsHub, deps: AuthLoginDeps): () => void {
  return hub.onCommand((_client, raw) => {
    const command = parseStart(raw)
    if (!command) return
    void deps
      .startLogin(command.facility, (e) => hub.broadcast({ type: `login-${e.kind}`, ...e }))
      .catch((error) => {
        hub.broadcast({
          type: 'login-failed',
          facility: command.facility,
          reason: String(error instanceof Error ? error.message : error).slice(0, 500),
        })
      })
  })
}
