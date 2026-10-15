package com.streamapp.android.a11y

import android.accessibilityservice.AccessibilityService
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityWindowInfo
import com.streamapp.android.agent.ChangeLog
import com.streamapp.android.agent.Rect
import com.streamapp.android.agent.isPageChange

/** The system-bound half. All op logic lives in `AndroidDevice`; this class only tracks the
 *  foreground component, feeds screen changes into [changes], and publishes itself while connected. */
class StreamAccessibilityService : AccessibilityService() {
    @Volatile var lastComponent: String = ""
        private set

    override fun onServiceConnected() {
        // Nodes from the previous binding are dead.
        changes.windowsChanged()
        instance = this
        listener?.invoke(true)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        if (event.eventType == AccessibilityEvent.TYPE_WINDOWS_CHANGED) {
            noteWindows()
            return
        }
        if (event.packageName?.toString() == packageName) return // the banner and WakeActivity are not "the foreground"
        if (event.eventType == AccessibilityEvent.TYPE_VIEW_SCROLLED) {
            if (event.windowId < 0) {
                changes.windowsChanged() // no window to pin it to: assume the worst
            } else {
                val area = event.source?.let { n -> android.graphics.Rect().also { n.getBoundsInScreen(it) } }
                changes.scrolled(event.windowId.toString(), area?.let { Rect(it.left, it.top, it.width(), it.height()) })
            }
        }
        if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            if (isPageChange(event.contentChangeTypes, event.className?.toString())) changes.windowsChanged()
            val pkg = event.packageName?.toString() ?: return
            val cls = event.className?.toString() ?: ""
            // Only activities name the screen; a Toast or a dialog class is not a place.
            lastComponent = if (cls.startsWith(pkg) || cls.contains("Activity")) "$pkg/$cls" else pkg
        }
    }

    /** A window opened, closed or moved. Only app and system windows count: the takeover banner
     *  (an accessibility overlay) appears, hides and toggles touch pass-through around our own
     *  ops, and must not stale the refs those ops are about to use. */
    private fun noteWindows() {
        changes.windows(windows.filter { it.type != AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY }.map { w ->
            val r = android.graphics.Rect().also { w.getBoundsInScreen(it) }
            "${w.id}/${w.type}/$r"
        })
    }

    override fun onInterrupt() {}

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        instance = null
        listener?.invoke(false)
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        if (instance === this) {
            instance = null
            listener?.invoke(false)
        }
        super.onDestroy()
    }

    companion object {
        @Volatile var instance: StreamAccessibilityService? = null
            private set
        @Volatile var listener: ((Boolean) -> Unit)? = null
        /** See `Device.changedSince`. Static, so it keeps counting across a service restart. */
        val changes = ChangeLog()
    }
}
