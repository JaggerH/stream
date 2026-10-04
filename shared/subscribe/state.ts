import { candidateKey } from './memberKey.ts'
import type { Candidate, CandidateState } from './types.ts'

/** Pure membership: a candidate is subscribed iff its memberKey is in the current channel's set.
 *  Recomputing for a different channel = call again with that channel's key set (zero requests). */
export function computeStates(candidates: Candidate[], subscribedKeys: Set<string>): CandidateState[] {
  return candidates.map((candidate) => {
    const key = candidateKey(candidate.sourceId, candidate.params)
    return { candidate, key, subscribed: subscribedKeys.has(key) }
  })
}
