package com.streamapp.android.agent

import org.json.JSONObject

/** The four reasons a ref fails, machine-readable in the error frame's `semantics.kind`
 *  (see the openspec change "android-observation-fields"). */
internal const val STALE_SNAPSHOT_UNKNOWN = "snapshot_unknown"
internal const val STALE_REF_NOT_IN_SNAPSHOT = "ref_not_in_snapshot"
internal const val STALE_REF_RETIRED = "ref_retired"
internal const val STALE_ELEMENT_MOVED = "element_moved"

/** A ref that cannot be acted on. The structured error channel carries the machine-readable kind:
 *  `code: "stale-ref"` on the frame, `semantics: {kind, ref}` beside it. */
internal class StaleRefException(msg: String, val kind: String, val ref: String) :
    AgentError(msg, "stale-ref", JSONObject().put("kind", kind).put("ref", ref))

/** A ref the table still tracks, with what was last known about its element. */
internal class Tracked<N>(
    val ref: String,
    val value: N,
    val fp: ElementFp,
    val windowId: String,
    val version: Long,
)

/**
 * Refs handed to the backend, stable across reads (design informed by Mika, Apache-2.0 — see the
 * openspec change). A ref stays valid until its element fails its freshness check at resolve time;
 * a new read does not invalidate it. When a later read contains a recognizable element with the
 * same identity key — unique in both reads, same window, no change event over its area since it
 * was last seen, in reach of its last position — that element inherits the ref, so the same
 * control keeps the same ref across reads. Everything else gets a fresh ref: numbers are
 * monotonic and a retired number is never reused. Unmatched entries stay tracked (bounded by
 * [capacity]) until they fail freshness, so a ref found earlier is still usable later.
 */
internal class RefTable<N>(private val capacity: Int = 256) {
    private class Entry<N>(val ref: String, var value: N, var fp: ElementFp, val windowId: String, var version: Long)

    private val entries = LinkedHashMap<String, Entry<N>>()
    private var serial = 0
    /** The last read's full fingerprint list and its window, for relocation's `before`. */
    private var lastRead: List<ElementFp> = emptyList()
    private var lastReadWindow: String? = null

    /**
     * Hands out refs for [hits] (fingerprints [fps], same order). [full] is the whole read's
     * fingerprints; [changed] reports whether anything changed over an area since [version]-like
     * moments — here, since an entry was last seen (window-level changes and scrolls over it),
     * which stops the carry-over exactly where list rows may have been recycled.
     */
    fun snapshot(
        hits: List<N>,
        fps: List<ElementFp>,
        full: List<ElementFp>,
        windowId: String,
        version: Long,
        shortEdge: Int,
        changed: (version: Long, windowId: String, rect: Rect) -> Boolean,
    ): List<String> {
        require(hits.size == fps.size) { "ref table: hits and fingerprints must align" }
        lastRead = full
        lastReadWindow = windowId
        val oldByKey = entries.values.filter { it.windowId == windowId }.groupBy { identityKey(it.fp) }
        val newCount = fps.groupingBy { identityKey(it) }.eachCount()
        val out = ArrayList<String>(hits.size)
        for (i in hits.indices) {
            val fp = fps[i]
            val key = identityKey(fp)
            var reused: Entry<N>? = null
            if (identifiable(fp) && newCount[key] == 1 && (oldByKey[key]?.size ?: 0) == 1) {
                val e = oldByKey[key]!![0]
                if (!changed(e.version, windowId, e.fp.rect)) {
                    val limit = shortEdge * (if (e.fp.inList || fp.inList) SAME_SPOT_SHIFT else RELOCATE_MAX_SHIFT)
                    if (shiftFp(e.fp, fp) <= limit) reused = e
                }
            }
            val ref: String
            if (reused != null) {
                ref = reused.ref
                reused.value = hits[i]
                reused.fp = fp
                reused.version = version
                // Refreshed entries move to the back: the table's eviction order is its LRU order.
                entries.remove(ref)
                entries[ref] = reused
            } else {
                serial++
                ref = "r$serial"
                entries[ref] = Entry(ref, hits[i], fp, windowId, version)
            }
            out += ref
        }
        while (entries.size > capacity) {
            val eldest = entries.keys.first()
            entries.remove(eldest)
        }
        return out
    }

    /** What the element behind [ref] was when last seen. Fails as [StaleRefException] with the
     *  kind telling the caller why: an unparsable or never-issued ref is `snapshot_unknown`, a
     *  retired number `ref_not_in_snapshot`; scope, window and freshness are the dispatcher's. */
    fun resolve(ref: String): Tracked<N> {
        val e = entries[ref]
        if (e == null) {
            val issued = Regex("^r(\\d+)$").matchEntire(ref)?.groupValues?.get(1)?.toIntOrNull()
            val kind = if (issued != null && issued <= serial) STALE_REF_NOT_IN_SNAPSHOT else STALE_SNAPSHOT_UNKNOWN
            throw StaleRefException("stale-ref: $ref is not a ref this agent still tracks; find it again", kind, ref)
        }
        return Tracked(ref, e.value, e.fp, e.windowId, e.version)
    }

    /** Re-binds [ref] to a relocated element (the dispatcher found it again in a fresh read). */
    fun refresh(ref: String, value: N, fp: ElementFp, version: Long) {
        val e = entries[ref] ?: return
        e.value = value
        e.fp = fp
        e.version = version
    }

    /** The last read's full fingerprints, when it was of [windowId]; empty otherwise. */
    fun lastReadOf(windowId: String): List<ElementFp> = if (lastReadWindow == windowId) lastRead else emptyList()

}
