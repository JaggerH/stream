package com.streamapp.android.a11y

import android.view.accessibility.AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY
import android.view.accessibility.AccessibilityWindowInfo.TYPE_APPLICATION
import android.view.accessibility.AccessibilityWindowInfo.TYPE_INPUT_METHOD
import android.view.accessibility.AccessibilityWindowInfo.TYPE_MAGNIFICATION_OVERLAY
import android.view.accessibility.AccessibilityWindowInfo.TYPE_SPLIT_SCREEN_DIVIDER
import java.util.Locale

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

/** The `windows` receipt's `type` for an `AccessibilityWindowInfo.TYPE_*`: application, input
 *  (method), accessibility overlay; everything else (system panes, split-screen divider,
 *  magnification) reports as `system`. */
internal fun windowTypeName(type: Int): String = when (type) {
    android.view.accessibility.AccessibilityWindowInfo.TYPE_APPLICATION -> "application"
    android.view.accessibility.AccessibilityWindowInfo.TYPE_INPUT_METHOD -> "input"
    TYPE_ACCESSIBILITY_OVERLAY -> "accessibility_overlay"
    else -> "system"
}

/**
 * Words the system's "app isn't responding" (ANR) dialog uses, in the languages the app ships.
 * The dialog is a system window; its title usually names the app but not the problem, so the
 * message text is what tells it apart from the notification shade or a volume pane.
 */
private val ANR_WORDS = listOf(
    "应用无响应", "应用没有响应", "应用未响应", "没有响应", "沒有響應", "未响应", "未響應",
    "沒有回應", "没有回应", "无响应", "無回應", "無響應",
    "isn't responding", "isn’t responding", "is not responding",
    "応答していません", "応答なし", "응답 없음", "응답하지 않음",
    "no responde", "no está respondiendo", "ne répond pas", "reagiert nicht",
    "non risponde", "не отвечает",
)

/**
 * Whether a system window is the ANR dialog. The AOSP dialog's buttons carry `android:id/aerr_*`,
 * which no translation changes; a build that renames them is caught by its message words.
 */
internal fun looksLikeAnr(title: String, labels: List<String>, viewIds: List<String>): Boolean {
    if (viewIds.any { it.contains("aerr_", ignoreCase = true) }) return true
    val text = (listOf(title) + labels).joinToString("\n").lowercase(Locale.ROOT)
    return ANR_WORDS.any { text.contains(it) }
}

private val SYSTEM_PACKAGES = setOf("android", "com.android.systemui")

/**
 * The app an ANR dialog is about: the dialog's own package when that names an app rather than the
 * system, else the application window directly below it (accessibility windows arrive top first).
 * Null when neither says which app it is; the host's own windows never count.
 */
internal fun anrOwner(windows: List<WindowFacts>, index: Int, host: String): String? {
    val own = windows[index].pkg
    if (own != null && own != host && own !in SYSTEM_PACKAGES) return own
    return windows.drop(index + 1)
        .firstOrNull { it.type == TYPE_APPLICATION && it.pkg != null && it.pkg != host }
        ?.pkg
}
