import type { AuthSpec } from '../manifest/types.ts'
import type { CredentialProvider, ResolvedCredential } from './types.ts'

/**
 * Resolves `auth: { type: 'token', name }` — the long-anticipated "token store" (see types.ts).
 * `map` binds a logical name to the env var holding its secret, e.g.
 * `{ cloudflare: 'CLOUDFLARE_WORKERS_AI_TOKEN' }`. Also exposes token() for host-side consumers
 * (transcribe backends), mirroring CookieProvider.cookieString().
 *
 * Two layers, **stored wins over env**. `stored` is the runtime_config overlay (Source Config
 * Sheet, or a recipe's one-shot `extract`); env is the deployment default. Stored wins because it
 * is the one that can change without a restart — a key obtained live has to take effect live, and
 * an env var silently outranking it would make the whole "let a recipe go get the key" path look
 * like it did nothing. Neither layer is ever logged.
 */
export class TokenProvider implements CredentialProvider {
  readonly id = 'token'

  constructor(
    private readonly map: Record<string, string>,
    private readonly env: NodeJS.ProcessEnv = process.env,
    /** logical name → the stored secret, or null when unset (runtime_config overlay) */
    private readonly stored?: (name: string) => string | null,
  ) {}

  async resolve(auth: AuthSpec): Promise<ResolvedCredential | null> {
    if (auth.type !== 'token') return null
    // RSSHub-catalog tokens name their env var directly (YOUTUBE_KEY, GITHUB_ACCESS_TOKEN), so an
    // unmapped name falls back to the env var of the same name. Curated manifests keep using the
    // logical-name → env-var `map`.
    const envVar = this.map[auth.name] ?? auth.name
    const val = this.stored?.(auth.name) || this.env[envVar]
    return val ? { envOverrides: { [envVar]: val } } : null
  }

  /** Direct token lookup for host-side use (not the manifest-auth path). */
  token(name: string): string | null {
    const envVar = this.map[name]
    return this.stored?.(name) || (envVar ? this.env[envVar] : undefined) || null
  }

  /** Which layer would resolve `name`, without ever returning the value itself — for view
   *  fields (keyState) that need to show "configured or not" without handling the secret. */
  layer(name: string): 'stored' | 'env' | null {
    if (this.stored?.(name)) return 'stored'
    const envVar = this.map[name] ?? name
    return this.env[envVar] ? 'env' : null
  }
}
