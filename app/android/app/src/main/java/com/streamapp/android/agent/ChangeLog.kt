package com.streamapp.android.agent

/**
 * The screen changes that can make a ref act on the wrong node: the window set changing (a page,
 * a dialog or a popup opening or closing) stales every ref; a view scrolling stales only refs
 * inside the area it covers, in its own window — a carousel ticking at the top of a page leaves
 * the search button alone. Fed by the accessibility service's event thread, read by the op worker.
 *
 * Only the latest change per window-level/area key is kept (any change after a version means the
 * latest one is after it too), so a carousel ticking all day takes one slot. Bounded beyond that: a
 * version older than what the log still remembers counts as changed.
 */
class ChangeLog(private val capacity: Int = 256) {
    /** [windowId] null: a window-level change. [area] null: the whole window. */
    private data class Key(val windowId: String?, val area: Rect?)

    private val latest = LinkedHashMap<Key, Long>()
    private var seq = 0L
    private var forgottenUpTo = 0L
    private var lastWindows: List<String>? = null

    @Synchronized fun version(): Long = seq

    @Synchronized fun windowsChanged() = add(Key(null, null))

    /** The current app/system windows, one signature each (id, type, bounds). Counts as a window
     *  change only when it differs from the last list seen. */
    @Synchronized fun windows(signature: List<String>) {
        if (signature == lastWindows) return
        lastWindows = signature
        add(Key(null, null))
    }

    @Synchronized fun scrolled(windowId: String, area: Rect?) = add(Key(windowId, area))

    @Synchronized fun changedSince(version: Long, windowId: String, rect: Rect): Boolean {
        if (version < forgottenUpTo) return true
        return latest.any { (k, s) ->
            s > version && (k.windowId == null || (k.windowId == windowId && (k.area == null || k.area.intersects(rect))))
        }
    }

    private fun add(k: Key) {
        latest.remove(k)
        latest[k] = ++seq
        while (latest.size > capacity) {
            val oldest = latest.entries.iterator()
            forgottenUpTo = oldest.next().value
            oldest.remove()
        }
    }
}

/** Whether a `TYPE_WINDOW_STATE_CHANGED` means another page: a pane title or a Toast is not one. */
fun isPageChange(contentChangeTypes: Int, className: String?): Boolean =
    contentChangeTypes == 0 && className?.contains("Toast") != true
