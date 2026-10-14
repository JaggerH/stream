package com.streamapp.android.a11y

import android.accessibilityservice.AccessibilityService
import android.view.accessibility.AccessibilityEvent

/** The system-bound half. All op logic lives in `AndroidDevice`; this class only tracks the
 *  foreground component and publishes itself while it is connected. */
class StreamAccessibilityService : AccessibilityService() {
    @Volatile var lastComponent: String = ""
        private set

    override fun onServiceConnected() {
        instance = this
        listener?.invoke(true)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            val pkg = event.packageName?.toString() ?: return
            val cls = event.className?.toString() ?: ""
            // Only activities name the screen; a Toast or a dialog class is not a place.
            lastComponent = if (cls.startsWith(pkg) || cls.contains("Activity")) "$pkg/$cls" else pkg
        }
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
    }
}
