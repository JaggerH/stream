/** Probes whether a Stream backend is answering on `baseUrl` (default the standard dev/prod
 *  HTTP port, GET /api/health — src/http/app.ts:679). A timeout or any fetch failure counts as
 *  "absent" — the stdio entry falls back to disk-service rather than hang waiting for a backend
 *  that may never come up (design D3). */
export async function probeBackend(baseUrl = 'http://127.0.0.1:8900', timeoutMs = 800): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch {
    return false
  }
}
