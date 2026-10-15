package com.streamapp.android.a11y

import android.accessibilityservice.AccessibilityService
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityWindowInfo
import java.util.concurrent.atomic.AtomicLong

/** The system-bound half. All op logic lives in `AndroidDevice`; this class only tracks the
 *  foreground component and the tree version, and publishes itself while it is connected. */
class StreamAccessibilityService : AccessibilityService() {
    @Volatile var lastComponent: String = ""
        private set

    override fun onServiceConnected() {
        // Nodes from the previous binding are dead.
        treeVersion.incrementAndGet()
        instance = this
        listener?.invoke(true)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        // The window set changing (a page, a dialog, a popup) or a list scrolling recycles nodes;
        // either one stales every ref handed out before it.
        if (event.eventType == AccessibilityEvent.TYPE_WINDOWS_CHANGED) {
            if (!isOwnOverlay(event.windowId)) treeVersion.incrementAndGet()
            return
        }
        if (event.packageName?.toString() == packageName) return // the banner and WakeActivity are not "the foreground"
        if (event.eventType == AccessibilityEvent.TYPE_VIEW_SCROLLED) treeVersion.incrementAndGet()
        if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) treeVersion.incrementAndGet()
        if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            val pkg = event.packageName?.toString() ?: return
            val cls = event.className?.toString() ?: ""
            // Only activities name the screen; a Toast or a dialog class is not a place.
            lastComponent = if (cls.startsWith(pkg) || cls.contains("Activity")) "$pkg/$cls" else pkg
        }
    }

    /** Ids of the takeover banner's windows: it appears, hides and toggles touch pass-through
     *  around our own ops, which must not stale the refs those ops are about to use. Events
     *  arrive on the main thread, so the set needs no lock. */
    private val overlayIds = mutableSetOf<Int>()

    private fun isOwnOverlay(windowId: Int): Boolean {
        if (windowId in overlayIds) return true
        val w = windows.firstOrNull { it.id == windowId } ?: return false
        if (w.type != AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY) return false
        overlayIds += windowId
        return true
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
        /** See `Device.treeVersion`. Static, so it keeps counting across a service restart. */
        val treeVersion = AtomicLong()
    }
}
