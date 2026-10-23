/** `#n=<nonce>` → nonce。走 fragment 而不是 query：fragment 不进任何请求，扩展页本来也不发请求，但不留痕更好。 */
export function parseClaimHash(hash: string): string | undefined {
  const n = new URLSearchParams(hash.replace(/^#/, '')).get('n')?.trim()
  return n && /^[A-Za-z0-9_-]{8,128}$/.test(n) ? n : undefined
}
