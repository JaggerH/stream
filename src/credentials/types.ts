import type { AuthSpec } from '../manifest/types.ts'

export interface ResolvedCredential {
  /** env vars to inject into the adapter before fetch */
  envOverrides: Record<string, string>
}

/**
 * A credential provider satisfies a manifest's auth declaration. Providers are
 * pluggable: cookies (from the browser snapshot) and BYOK tokens today; another
 * kind can be added later without touching adapters or manifests.
 */
export interface CredentialProvider {
  id: string
  /** return null if this provider cannot satisfy the given auth */
  resolve(auth: AuthSpec): Promise<ResolvedCredential | null>
}
