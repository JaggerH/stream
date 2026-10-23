import { useCallback, useEffect, useState } from 'react'
import { Check, Link2, RefreshCw, Trash2, X } from 'lucide-react'
import type { Binding } from '../../lib/config.ts'
import { isPairableAddress, isPlaintextRemote } from '../../lib/pair-code.ts'
import { Button } from '@/components/acrylic/button.tsx'
import { Badge } from '@/components/acrylic/badge.tsx'
import { Item, ItemContent, ItemTitle, ItemDescription, ItemActions } from '@/components/acrylic/item.tsx'
import { InputGroup, InputGroupInput } from '@/components/acrylic/input-group.tsx'

/** What the SW hands the popup for each binding — never the token. */
type BindingView = Omit<Binding, 'token'> & { connected: boolean; pending: string[] }

/** One round-trip to the background SW (it owns the connections and the storage writes). */
function ask<T>(msg: Record<string, unknown>): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>
}

/**
 * Streams tab (design D7): every Stream this browser serves. The local one comes from the
 * native host and needs nothing here; others are added with a one-time code that Stream minted
 * for a device, and each new cookie domain such a Stream asks for waits here for approval.
 */
export function BindingsPanel() {
  const [list, setList] = useState<BindingView[] | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  const refresh = useCallback(async () => {
    const r = await ask<{ bindings?: BindingView[]; error?: string }>({ type: 'bindings-status' })
    setList(r.bindings ?? [])
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])

  const addressOk = baseUrl.trim() === '' || isPairableAddress(baseUrl.trim())

  async function pair() {
    setBusy(true)
    setNote(null)
    const r = await ask<{ ok: boolean; deviceName?: string; error?: string }>({ type: 'binding-pair', baseUrl, code })
    setBusy(false)
    if (r.ok) {
      setNote({ ok: true, text: `Paired — this browser now runs tasks for ${r.deviceName}.` })
      setCode('')
      setBaseUrl('')
    } else {
      setNote({ ok: false, text: r.error ?? 'Pairing failed.' })
    }
    void refresh()
  }

  async function remove(id: string) {
    await ask({ type: 'binding-remove', id })
    void refresh()
  }

  async function approve(id: string, domain: string) {
    await ask({ type: 'binding-approve', id, domain })
    void refresh()
  }

  async function reconnect(id: string) {
    await ask({ type: 'relay-reconnect', id })
    setTimeout(() => void refresh(), 1500)
  }

  return (
    <div className="flex flex-col gap-2">
      {(list ?? []).map((b) => (
        <Item key={b.id} variant="muted" size="sm" className="items-start">
          <ItemContent>
            <ItemTitle className="text-[13px]">
              {b.kind === 'local' ? 'This computer’s Stream' : b.label}
              {b.revoked ? (
                <Badge variant="outline" size="sm">revoked</Badge>
              ) : b.foreignNode ? (
                <Badge variant="outline" size="sm">other profile</Badge>
              ) : (
                <Badge variant="secondary" size="sm">{b.connected ? 'connected' : 'offline'}</Badge>
              )}
            </ItemTitle>
            <ItemDescription className="truncate">{b.baseUrl || 'not found yet'}</ItemDescription>
            {b.revoked && (
              <p className="text-[11px] text-[var(--acr-orange)]">
                That Stream revoked this browser. Remove it here; pair again if you still need it.
              </p>
            )}
            {b.foreignNode && !b.revoked && (
              <p className="text-[11px] text-[var(--acr-orange)]">
                这条绑定属于另一个 profile。在这里移除它，再给这个 profile 单独配对。
              </p>
            )}
            {b.pending.length > 0 && !b.revoked && !b.foreignNode && (
              <div className="mt-1 flex flex-col gap-1">
                <span className="text-[11px] text-muted-foreground">Wants cookies for:</span>
                {b.pending.map((d) => (
                  <div key={d} className="flex items-center gap-1.5 text-[11px]">
                    <span className="truncate font-mono">{d}</span>
                    <Button size="mini" variant="default" className="ml-auto h-5" onClick={() => void approve(b.id, d)}>
                      <Check /> Allow
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </ItemContent>
          {b.kind === 'paired' && (
            <ItemActions>
              {!b.revoked && !b.foreignNode && !b.connected && (
                <Button icon size="mini" variant="ghost" aria-label="Reconnect" onClick={() => void reconnect(b.id)}>
                  <RefreshCw />
                </Button>
              )}
              <Button icon size="mini" variant="ghost" aria-label="Remove" onClick={() => void remove(b.id)}>
                <Trash2 />
              </Button>
            </ItemActions>
          )}
        </Item>
      ))}

      <div className="flex flex-col gap-1.5 rounded-[9px] bg-[var(--acr-card-nested)] p-2.5">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Link2 className="size-3.5" /> Add a Stream
        </div>
        <InputGroup>
          <InputGroupInput value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://stream.example.com" />
        </InputGroup>
        {!addressOk && (
          <p className="text-[11px] text-[var(--acr-orange)]">Enter an http:// or https:// address.</p>
        )}
        {addressOk && isPlaintextRemote(baseUrl.trim()) && (
          <p className="text-[11px] text-muted-foreground">
            Not encrypted: anyone on the network path can read the pairing token and the cookies you
            share. Fine on your home network or Tailscale; use https:// over the internet.
          </p>
        )}
        <InputGroup>
          <InputGroupInput
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="6-digit code from that Stream"
            inputMode="numeric"
          />
        </InputGroup>
        <Button
          size="small"
          variant="default"
          className="h-6 self-start"
          disabled={busy || !baseUrl.trim() || !addressOk || code.length !== 6}
          onClick={() => void pair()}
        >
          {busy ? 'Pairing…' : 'Pair'}
        </Button>
        {note && (
          <p className={`flex items-center gap-1 text-[11px] ${note.ok ? 'text-muted-foreground' : 'text-[var(--acr-orange)]'}`}>
            {note.ok ? <Check className="size-3" /> : <X className="size-3" />} {note.text}
          </p>
        )}
      </div>
    </div>
  )
}
