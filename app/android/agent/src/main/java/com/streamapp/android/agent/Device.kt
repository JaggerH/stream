package com.streamapp.android.agent

import org.json.JSONObject

/** [self]: the window belongs to the app this agent runs in (the host). Such rows are listed by
 *  the `windows` op so a caller can see the host is in front, but never scoped, searched or acted on. */
internal data class WindowInfo(val id: String, val process: String, val title: String, val foreground: Boolean, val self: Boolean = false)
internal data class Shot(val jpeg: ByteArray, val window: Rect, val scale: Double)

internal interface Device {
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
    /** Epoch ms of the most recent user touch the accessibility service observed — excluding the
     *  ones our own injected gestures produced (see [UserInputTracker]). `null` when none was
     *  observed since the service connected. */
    fun lastUserInputMs(): Long?
    /** `package/activityClass` of the foreground window, or `package` when the activity is unknown. */
    fun foregroundComponent(): String
    /** Opens the app. [fresh] = at its launcher activity with its task cleared; otherwise the app
     *  resumes the page it was left on (a running task is brought to the front as it is). */
    fun launch(packageName: String, fresh: Boolean = false): Boolean
    /** One accessibility scroll step on a scrollable container: [forward] = towards content further
     *  down (`ACTION_SCROLL_DOWN` where the node offers it, else `ACTION_SCROLL_FORWARD`). False when
     *  the node does not offer that direction or refused (typically: already at that end). True does
     *  not prove anything moved: the dispatcher compares the content before and after. */
    fun scrollNode(node: UiNode, forward: Boolean): Boolean
    fun click(node: UiNode): Boolean
    fun setText(node: UiNode, text: String): Boolean
    fun focusedInput(): UiNode?
    fun imeEnter(node: UiNode): Boolean
    fun tap(x: Int, y: Int, longPress: Boolean)
    /** A straight swipe; with [holdMs] > 0 the finger rests at the end point that long before
     *  lifting, so the view sees no fling velocity. */
    fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Long, holdMs: Long = 0)
    fun globalBack(): Boolean
    fun globalHome(): Boolean
    /** A screenshot with the given screen rects covered in black (credential fields and
     *  one-time-code text), so no credential value leaves in a frame. */
    fun screenshot(maskedAreas: List<Rect> = emptyList()): Shot
    fun screenSize(): Rect
    /** The system's touch slop in pixels: a move shorter than this is still a tap. */
    fun touchSlop(): Int
    /** Display density (px per dp). */
    fun density(): Float
    fun status(text: String?)
    fun sleep(ms: Long)
}

/** An op failure. [code] is the machine-readable family (`approval-required`, `device-busy`…);
 *  when null, the caller derives it from the message's `<code>: <人话>` prefix. [semantics]
 *  carries the structured receipt an `approval-required` reply shows the approver. */
internal class AgentError(msg: String, val code: String? = null, val semantics: JSONObject? = null) : Exception(msg) {
    val errorCode: String
        get() = code ?: message?.substringBefore(':')?.trim()?.takeIf { it.isNotBlank() && ' ' !in it } ?: ""
}
