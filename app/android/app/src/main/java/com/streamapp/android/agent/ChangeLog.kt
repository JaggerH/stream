package com.streamapp.android.agent

/**
 * The screen changes that can make a ref act on the wrong node: the window set changing (a page,
 * a dialog or a popup opening or closing) stales every ref; a view scrolling stales only refs
 * inside the area it covers, in its own window — a carousel ticking at the top of a page leaves
 * the search button alone. Bounded: a version older than what the log still remembers counts as
 * changed. Fed by the accessibility service's event thread, read by the op worker.
 */
class ChangeLog(private val capacity: Int = 256) {
    /** [windowId] null: a window-level change. [area] null: the whole window. */
    private class Change(val seq: Long, val windowId: String?, val area: Rect?)

    private val changes = ArrayDeque<Change>()
    private var seq = 0L
    private var forgottenUpTo = 0L

    @Synchronized fun version(): Long = seq

    @Synchronized fun windowsChanged() = add(Change(++seq, null, null))

    @Synchronized fun scrolled(windowId: String, area: Rect?) = add(Change(++seq, windowId, area))

    @Synchronized fun changedSince(version: Long, windowId: String, rect: Rect): Boolean {
        if (version < forgottenUpTo) return true
        return changes.any { c ->
            c.seq > version && (c.windowId == null || (c.windowId == windowId && (c.area == null || c.area.intersects(rect))))
        }
    }

    private fun add(c: Change) {
        changes.addLast(c)
        while (changes.size > capacity) forgottenUpTo = changes.removeFirst().seq
    }
}
