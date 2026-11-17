package com.streamapp.android.a11y

import android.view.accessibility.AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY
import android.view.accessibility.AccessibilityWindowInfo.TYPE_APPLICATION
import android.view.accessibility.AccessibilityWindowInfo.TYPE_INPUT_METHOD
import android.view.accessibility.AccessibilityWindowInfo.TYPE_MAGNIFICATION_OVERLAY
import android.view.accessibility.AccessibilityWindowInfo.TYPE_SPLIT_SCREEN_DIVIDER

/** What the agent reads of one accessibility window to judge it: [type] is
 *  `AccessibilityWindowInfo.TYPE_*`, [pkg] its root's package (null when the root is unreadable). */
internal data class WindowFacts(val id: String, val type: Int, val pkg: String?, val active: Boolean, val focused: Boolean)

/**
 * Whether a window can be "the app in front". Never: an accessibility overlay (the agent's own
 * banner, a host's panel drawn through the service, another service's overlay), the keyboard, the
 * split-screen divider or the magnification frame, nor a window of the host app [host] other than
 * its activities (an overlay it shows through another window type). An accessibility overlay that
 * takes input focus becomes the active window, which must not make the host "the foreground app".
 */
internal fun canBeForeground(type: Int, pkg: String?, host: String): Boolean = when {
    pkg == null -> false
    type == TYPE_ACCESSIBILITY_OVERLAY || type == TYPE_INPUT_METHOD ||
        type == TYPE_SPLIT_SCREEN_DIVIDER || type == TYPE_MAGNIFICATION_OVERLAY -> false
    pkg == host && type != TYPE_APPLICATION -> false
    else -> true
}

/** The foreground window among [windows] (z-order, top first): the active one, else the focused
 *  one, else the topmost application window — each among the windows that [canBeForeground]. */
internal fun pickForeground(windows: List<WindowFacts>, host: String): WindowFacts? {
    val ok = windows.filter { canBeForeground(it.type, it.pkg, host) }
    return ok.firstOrNull { it.active } ?: ok.firstOrNull { it.focused } ?: ok.firstOrNull { it.type == TYPE_APPLICATION }
}

/** Whether a window of [type] takes part in the screen-change log behind refs. The keyboard and
 *  accessibility overlays do not: they come and go over the page without changing what is on it. */
internal fun countsForChanges(type: Int): Boolean = type != TYPE_INPUT_METHOD && type != TYPE_ACCESSIBILITY_OVERLAY

/** Whether a `TYPE_WINDOW_STATE_CHANGED` from window type [windowType] (null when the window is not
 *  in the list) and package [pkg] may change the page: not when it comes from the keyboard (by
 *  window type, or by package — the keyboard's event can arrive before its window is listed) or
 *  an accessibility overlay. */
internal fun stateChangeCounts(windowType: Int?, pkg: String?, imePackages: Set<String>): Boolean =
    (windowType == null || countsForChanges(windowType)) && (pkg == null || pkg !in imePackages)

/** Whether a touch on a window of [type] and package [pkg] is a touch on the agent's or the host's
 *  own surface rather than on the app in front: any accessibility overlay, or any window of [host]. */
internal fun isOwnSurface(type: Int?, pkg: String?, host: String): Boolean =
    type == TYPE_ACCESSIBILITY_OVERLAY || (pkg != null && pkg == host)
