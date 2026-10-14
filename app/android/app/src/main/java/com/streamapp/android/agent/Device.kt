package com.streamapp.android.agent

data class WindowInfo(val id: String, val process: String, val title: String, val foreground: Boolean)
data class Shot(val jpeg: ByteArray, val window: Rect, val scale: Double)

interface Device {
    /** Throws `device-locked:` when a secure keyguard is up; wakes the screen otherwise. */
    fun ensureAwake()
    /** Throws `a11y-off:` when the accessibility service is not connected. */
    fun windows(): List<WindowInfo>
    /** Root of the window with this id, or null if it is gone. */
    fun windowRoot(windowId: String): UiNode?
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
    fun screenshot(): Shot
    fun screenSize(): Rect
    fun status(text: String?)
    fun sleep(ms: Long)
}

class AgentError(msg: String) : Exception(msg)
