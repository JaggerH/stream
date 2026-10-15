package com.streamapp.android.agent

/**
 * One request's cancellation token. The relay cancels it when the user taps Stop or the
 * connection that sent the request is gone; the dispatcher checks it before every device call.
 */
class Cancel {
    @Volatile private var reason: String? = null

    val cancelled get() = reason != null

    fun cancel(why: String = "aborted: 已停止") { if (reason == null) reason = why }

    fun check() { reason?.let { throw AgentError(it) } }
}

/**
 * [inner] with [cancel] checked before and after every call, so a cancelled request stops at its
 * next step: the second swipe of a scroll, the tap after a wake. Sleeps run in short slices.
 */
class CancellableDevice(private val inner: Device, private val cancel: Cancel) : Device {
    private inline fun <T> guard(f: () -> T): T { cancel.check(); return f().also { cancel.check() } }

    override fun ensureAwake() = guard { inner.ensureAwake() }
    override fun windows() = guard { inner.windows() }
    override fun windowRoot(windowId: String) = guard { inner.windowRoot(windowId) }
    override fun windowBounds(windowId: String) = guard { inner.windowBounds(windowId) }
    override fun treeVersion() = guard { inner.treeVersion() }
    override fun isCurrent(node: UiNode) = guard { inner.isCurrent(node) }
    override fun changedSince(version: Long, windowId: String, rect: Rect) = guard { inner.changedSince(version, windowId, rect) }
    override fun foregroundPackage() = guard { inner.foregroundPackage() }
    override fun foregroundComponent() = guard { inner.foregroundComponent() }
    override fun launch(packageName: String) = guard { inner.launch(packageName) }
    override fun click(node: UiNode) = guard { inner.click(node) }
    override fun setText(node: UiNode, text: String) = guard { inner.setText(node, text) }
    override fun focusedInput() = guard { inner.focusedInput() }
    override fun imeEnter(node: UiNode) = guard { inner.imeEnter(node) }
    override fun tap(x: Int, y: Int, longPress: Boolean) = guard { inner.tap(x, y, longPress) }
    override fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Long) = guard { inner.swipe(x1, y1, x2, y2, durationMs) }
    override fun globalBack() = guard { inner.globalBack() }
    override fun globalHome() = guard { inner.globalHome() }
    override fun screenshot() = guard { inner.screenshot() }
    override fun screenSize() = guard { inner.screenSize() }
    override fun status(text: String?) = guard { inner.status(text) }

    override fun sleep(ms: Long) {
        var left = ms.coerceIn(0, 30_000)
        do {
            cancel.check()
            val slice = minOf(left, SLICE_MS)
            inner.sleep(slice)
            left -= slice
        } while (left > 0)
        cancel.check()
    }

    private companion object { const val SLICE_MS = 250L }
}
