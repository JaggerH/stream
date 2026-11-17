package com.streamapp.android.a11y

import android.accessibilityservice.AccessibilityService
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityWindowInfo
import com.streamapp.android.StreamAgent
import com.streamapp.android.agent.ChangeLog
import com.streamapp.android.agent.ForegroundComponents
import com.streamapp.android.agent.Rect
import com.streamapp.android.agent.UserInputTracker
import com.streamapp.android.agent.isPageChange

/** The system-bound half. All op logic lives in `AndroidDevice`; this class only tracks the
 *  foreground component, feeds screen changes into [changes], and publishes itself while connected. */
internal class StreamAccessibilityService : AccessibilityService() {
    override fun onServiceConnected() {
        // Nodes from the previous binding are dead.
        changes.windowsChanged()
        // The window set as it stands now is the baseline: the first windows event after a
        // (re)connect must not count as a change by itself.
        noteWindows()
        instance = this
        listener?.invoke(true)
        StreamAgent.changed()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        if (event.eventType == AccessibilityEvent.TYPE_TOUCH_INTERACTION_START) {
            // A human touched the screen — unless it was one of our own injected gestures, which
            // the tracker excludes (the fact `app-in-use` judges on), or a touch on an overlay or a
            // window of the host app, which is not the user using the app in front.
            inputs.onTouchInteraction(System.currentTimeMillis(), ownSurface = touchedOwnSurface(event))
            return
        }
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
            // The keyboard or an overlay opening is not another page.
            if (isPageChange(event.contentChangeTypes, event.className?.toString()) &&
                stateChangeCounts(windowTypeOf(event.windowId), event.packageName?.toString(), imePackages())
            ) {
                if (event.windowId < 0) changes.windowsChanged()
                else changes.pageEvent(event.windowId.toString(), event.className?.toString() ?: "")
            }
            val pkg = event.packageName?.toString() ?: return
            components.windowStateChanged(pkg, event.className?.toString() ?: "")
        }
    }

    /** A window opened, closed or moved. Only app and system windows count ([countsForChanges]):
     *  the takeover banner (an accessibility overlay) appears, hides and toggles touch pass-through
     *  around our own ops, and the keyboard shows and hides around every text entry; neither must
     *  stale the refs found on the page under them. */
    private fun noteWindows() {
        val ws = windows
        ws.filter { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD }
            .mapNotNullTo(seenImes) { it.root?.packageName?.toString() }
        changes.windows(ws.filter { countsForChanges(it.type) }.map { w ->
            val r = android.graphics.Rect().also { w.getBoundsInScreen(it) }
            "${w.id}/${w.type}/$r"
        })
    }

    private fun windowTypeOf(windowId: Int): Int? =
        if (windowId < 0) null else windows.firstOrNull { it.id == windowId }?.type

    /** Keyboard packages: the default input method and any whose window was seen. */
    private fun imePackages(): Set<String> {
        val def = android.provider.Settings.Secure.getString(contentResolver, android.provider.Settings.Secure.DEFAULT_INPUT_METHOD)
            ?.substringBefore('/')
        return if (def.isNullOrEmpty()) seenImes else seenImes + def
    }

    /** The window a touch landed on, as far as the event tells: its own window id, or — only while
     *  touch exploration is on, when the system makes the touched window the active one — the
     *  active window; else the event's package. Unknown counts as not ours. */
    private fun touchedOwnSurface(event: AccessibilityEvent): Boolean {
        val ws = windows
        val w = if (event.windowId >= 0) ws.firstOrNull { it.id == event.windowId }
            else if (getSystemService(android.view.accessibility.AccessibilityManager::class.java)?.isTouchExplorationEnabled == true) ws.firstOrNull { it.isActive }
            else null
        if (w == null) return event.packageName?.toString() == packageName
        return isOwnSurface(w.type, w.root?.packageName?.toString(), packageName)
    }

    override fun onInterrupt() {}

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        instance = null
        listener?.invoke(false)
        StreamAgent.changed()
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        if (instance === this) {
            instance = null
            listener?.invoke(false)
            StreamAgent.changed()
        }
        super.onDestroy()
    }

    companion object {
        @Volatile var instance: StreamAccessibilityService? = null
            private set
        @Volatile var listener: ((Boolean) -> Unit)? = null
        /** See `Device.changedSince`. Static, so it keeps counting across a service restart. */
        val changes = ChangeLog()
        /** See `Device.foregroundComponent`. */
        val components = ForegroundComponents()
        /** See `Device.lastUserInputMs`. Static, so it survives a service restart like [changes]. */
        val inputs = UserInputTracker()
        /** Keyboard packages seen as `TYPE_INPUT_METHOD` windows. */
        private val seenImes: MutableSet<String> = java.util.concurrent.ConcurrentHashMap.newKeySet()
    }
}
