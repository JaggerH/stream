package com.streamapp.android.policy

import com.streamapp.android.agent.UiNode
import org.json.JSONArray
import org.json.JSONObject
import java.io.InputStream
import java.util.UUID

/** A masked screenshot kept device-side for the caller to fetch through the `screenshot` op's
 *  `snapshotRef` argument, and the digest payloads of one approval request. */
class StoredSnapshot(val ref: String, val jpeg: ByteArray, val window: com.streamapp.android.agent.Rect, val scale: Double)

/**
 * The policy engine's process-lifetime state: the word and category tables, this device's
 * binding identity, the consumed approval ids and the kept masked snapshots. One instance per
 * app process; a process restart mints a new session-lease id, so every approval credential
 * issued before the restart fails its binding check on replay.
 */
class PolicyContext(val deviceId: String, words: Words, val categories: Categories) {

    /** The session lease the binding digest is tied to: never persisted, never reused. */
    val leaseId: String = UUID.randomUUID().toString()
    val detect = Detect(words)
    val masker = Masker(detect)
    val gate = Gate(detect, categories)

    /**
     * Consumed approval ids, kept as a bounded LRU (a suspended session's worth of approvals,
     * not an unbounded audit log). Connection drops do not clear it; a process restart does —
     * and by then the lease has rotated, so replayed credentials fail the binding check before
     * the one-shot check is ever reached.
     */
    private val consumed = object : LinkedHashMap<String, Unit>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Unit>?): Boolean = size > CONSUMED_CAP
    }

    @Synchronized fun isConsumed(id: String) = consumed.containsKey(id)

    /** Marks [id] consumed; returns false when it was already spent. */
    @Synchronized fun consume(id: String): Boolean {
        if (consumed.containsKey(id)) return false
        consumed[id] = Unit
        return true
    }

    /** Masked screenshots for `snapshotRef`, bounded: the last few approval requests, this process. */
    private val snapshots = ArrayDeque<StoredSnapshot>()

    @Synchronized fun putSnapshot(jpeg: ByteArray, window: com.streamapp.android.agent.Rect, scale: Double): String {
        while (snapshots.size >= SNAPSHOT_KEEP) snapshots.removeFirst()
        val ref = "snap-${UUID.randomUUID()}"
        snapshots.addLast(StoredSnapshot(ref, jpeg, window, scale))
        return ref
    }

    @Synchronized fun getSnapshot(ref: String): StoredSnapshot? = snapshots.firstOrNull { it.ref == ref }

    // ---- digests ---------------------------------------------------------------------

    /**
     * digest(device, session lease, op, canonicalized args) — SHA-256 over
     * `"stream-binding-v1\n<deviceId>\n<leaseId>\n<op>\n<canonicalArgs>"`. The caller only
     * echoes it back; the canonicalization lives here so both sides never drift. `approval`
     * itself is stripped before hashing, so the resend-with-credential hashes like the
     * original ask.
     */
    fun bindingDigest(op: String, args: JSONObject): String {
        val clean = JSONObject()
        for (k in args.keys()) if (k != "approval") clean.put(k, args.get(k))
        return ScreenDigest.sha256("stream-binding-v1\n$deviceId\n$leaseId\n$op\n${canonical(clean)}")
    }

    fun screenDigest(maskedRoot: UiNode): String = ScreenDigest.of(maskedRoot)

    /** Canonical JSON: object keys sorted, no whitespace, strings quoted. Pinned by tests. */
    fun canonical(v: Any?): String = when (v) {
        null -> "null"
        is JSONObject -> v.keys().asSequence().sorted()
            .joinToString(",", "{", "}") { JSONObject.quote(it) + ":" + canonical(v.get(it)) }
        is JSONArray -> (0 until v.length()).joinToString(",", "[", "]") { canonical(v[it]) }
        is Int, is Long, is Boolean -> v.toString()
        is Double -> v.toString()
        else -> JSONObject.quote(v.toString())
    }

    companion object {
        const val CONSUMED_CAP = 256
        const val SNAPSHOT_KEEP = 8

        /** Loads both tables from [open]; the app passes its assets, tests the source tree. */
        fun fromStreams(open: (String) -> InputStream, deviceId: String): PolicyContext =
            PolicyContext(deviceId, Words.load(open), Categories.load(open))

        /** From the module's source assets — for JVM unit tests, whose working directory is the
         *  Android module directory. */
        fun fromSourceTree(deviceId: String): PolicyContext =
            fromStreams({ path -> java.io.File("src/main/assets/$path").inputStream() }, deviceId)
    }
}
