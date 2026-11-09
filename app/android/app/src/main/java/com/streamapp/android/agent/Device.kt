package com.streamapp.android.agent

import org.json.JSONObject

data class WindowInfo(val id: String, val process: String, val title: String, val foreground: Boolean)
data class Shot(val jpeg: ByteArray, val window: Rect, val scale: Double)

interface Device {
    /** Throws `device-locked:` when a secure keyguard is up; wakes the screen otherwise. */
    fun ensureAwake()
    /** Throws `a11y-off:` when the accessibility service is not connected. */
    fun windows(): List<WindowInfo>
    /** Root of the window with this id, or null if it is gone. */
    fun windowRoot(windowId: String): UiNode?
    /** Screen bounds of the window with this id without snapshotting its tree, or null if it is gone. */
    fun windowBounds(windowId: String): Rect?
    /** A sequence number of screen changes; [changedSince] compares against it. */
    fun treeVersion(): Long
    /** Whether, since [version], the window set changed (a page, dialog or popup opened or closed)
     *  or a view in window [windowId] scrolled over [rect] — the moments list rows get recycled.
     *  A carousel ticking elsewhere on the page does not count. */
    fun changedSince(version: Long, windowId: String, rect: Rect): Boolean
    /** Whether the live node behind [node] still shows what the snapshot recorded. */
    fun isCurrent(node: UiNode): Boolean
    fun foregroundPackage(): String?
    /** `package/activityClass` of the foreground window, or `package` when the activity is unknown. */
    fun foregroundComponent(): String
    fun launch(packageName: String): Boolean
    fun click(node: UiNode): Boolean
    fun setText(node: UiNode, text: String): Boolean
    fun focusedInput(): UiNode?
    fun imeEnter(node: UiNode): Boolean
    fun tap(x: Int, y: Int, longPress: Boolean)
    fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Long)
    fun globalBack(): Boolean
    fun globalHome(): Boolean
    /** A screenshot with the given screen rects covered in black (credential fields and
     *  one-time-code text), so no credential value leaves in a frame. */
    fun screenshot(maskedAreas: List<Rect> = emptyList()): Shot
    fun screenSize(): Rect
    fun status(text: String?)
    fun sleep(ms: Long)
}

/** An op failure. [code] is the machine-readable family (`approval-required`, `device-busy`…);
 *  when null, the caller derives it from the message's `<code>: <人话>` prefix. [semantics]
 *  carries the structured receipt an `approval-required` reply shows the approver. */
class AgentError(msg: String, val code: String? = null, val semantics: JSONObject? = null) : Exception(msg) {
    val errorCode: String
        get() = code ?: message?.substringBefore(':')?.trim()?.takeIf { it.isNotBlank() && ' ' !in it } ?: ""
}
