import type { AuthSpec } from '../manifest/types.ts'
import type { CredentialProvider } from './types.ts'

/**
 * Resolves a manifest's auth declaration against an ordered list of providers
 * (first non-null wins). Adapters receive only the resulting env overrides and
 * never know which provider produced them.
 */
export class CredentialResolver {
  constructor(private readonly providers: CredentialProvider[]) {}

  async resolve(auth: AuthSpec): Promise<Record<string, string>> {
    if (auth.type === 'none') return {}
    if (auth.type === 'session') return {}

    for (const p of this.providers) {
      const r = await p.resolve(auth)
      if (r) return r.envOverrides
    }

    // The route declares the credential OPTIONAL (RSSHub's requireConfig[].optional): it works
    // without one. Proceed unauthenticated rather than failing the fetch — an unresolved optional
    // credential is not an error.
    if (auth.optional) return {}

    const detail =
      auth.type === 'cookie' ? `cookie for domain "${auth.domain}"` : `token "${auth.name}"`
    throw new Error(`No credential provider could resolve ${detail}`)
  }

  /** bound function for injection into the Scheduler */
  fn(): (auth: AuthSpec) => Promise<Record<string, string>> {
    return (auth) => this.resolve(auth)
  }
}
