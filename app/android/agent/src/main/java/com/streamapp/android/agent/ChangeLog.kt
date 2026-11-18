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
internal class ChangeLog(private val capacity: Int = 256) {
    /** [windowId] null: a window-level change. [area] null: the whole window. */
    private data class Key(val windowId: String?, val area: Rect?)

    private val latest = LinkedHashMap<Key, Long>()
    private var seq = 0L
    private var forgottenUpTo = 0L
    private var lastWindows: List<String>? = null
    private var lastEventAt = 0L

    @Synchronized fun version(): Long = seq

    /** Records that an accessibility event arrived (any event; the agent's own surfaces
     *  excluded by the caller). The settle wait's quiet clock reads [lastEventAtMs]. */
    @Synchronized fun event() { lastEventAt = System.currentTimeMillis() }

    /** Epoch ms of the most recent event, or null when none was seen since the service started. */
    @Synchronized fun lastEventAtMs(): Long? = if (lastEventAt == 0L) null else lastEventAt

    @Synchronized fun windowsChanged() = add(Key(null, null))

    /** The current app/system windows, one signature each (id, type, bounds). Counts as a window
     *  change only when it differs from the last list seen. */
    @Synchronized fun windows(signature: List<String>) {
        if (signature == lastWindows) return
        lastWindows = signature
        add(Key(null, null))
    }

    @Synchronized fun scrolled(windowId: String, area: Rect?) = add(Key(windowId, area))

    private val pages = object : LinkedHashMap<String, String>() {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?) = size > 64
    }

    /** A page-change event (`TYPE_WINDOW_STATE_CHANGED`) from window [windowId] naming class [cls].
     *  Counts as a window change unless that window's last such event named the same class: a
     *  window getting its focus back (after a focusable overlay or a panel above it closed) repeats
     *  its activity's event without showing another page. */
    @Synchronized fun pageEvent(windowId: String, cls: String) {
        if (pages[windowId] == cls) return
        pages[windowId] = cls
        add(Key(null, null))
    }

    @Synchronized fun changedSince(version: Long, windowId: String, rect: Rect): Boolean {
        if (version < forgottenUpTo) return true
        return latest.any { (k, s) ->
            s > version && (k.windowId == null || (k.windowId == windowId && (k.area == null || k.area.intersects(rect))))
        }
    }

    /** Whether a scroll was logged over [rect] in [windowId] since [version] — window-level
     *  changes do not count. This is the "list rows may have been recycled" signal. */
    @Synchronized fun scrolledSince(version: Long, windowId: String, rect: Rect): Boolean {
        if (version < forgottenUpTo) return true
        return latest.any { (k, s) ->
            s > version && k.windowId == windowId && (k.area == null || k.area.intersects(rect))
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
internal fun isPageChange(contentChangeTypes: Int, className: String?): Boolean =
    contentChangeTypes == 0 && className?.contains("Toast") != true
