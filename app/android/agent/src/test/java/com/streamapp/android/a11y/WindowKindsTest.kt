package com.streamapp.android.a11y

import com.streamapp.android.agent.ChangeLog
import com.streamapp.android.agent.Rect
import org.junit.Assert.*
import org.junit.Test

/** Which windows are the app in front, which take part in ref invalidation, and which touches are ours. */
class WindowKindsTest {
    // AccessibilityWindowInfo.TYPE_*
    private val app = 1
    private val ime = 2
    private val system = 3
    private val overlay = 4
    private val divider = 5
    private val host = "com.example.host"

    private fun w(id: String, type: Int, pkg: String?, active: Boolean = false, focused: Boolean = false) =
        WindowFacts(id, type, pkg, active, focused)

    @Test fun aFocusedOverlayOfTheHostIsNotTheForegroundApp() {
        // The host's panel with a text field took input focus: it is the active window.
        val ws = listOf(
            w("9", overlay, host, active = true, focused = true),
            w("3", system, "com.android.systemui"),
            w("5", app, "com.android.settings"),
        )
        assertEquals("com.android.settings", pickForeground(ws, host)?.pkg)
    }

    @Test fun theActiveAppWindowWins() {
        val ws = listOf(w("3", system, "com.android.systemui"), w("5", app, "com.android.settings", active = true, focused = true))
        assertEquals("5", pickForeground(ws, host)?.id)
        // The notification shade, when it is the active window, is what is in front.
        val shade = listOf(w("3", system, "com.android.systemui", active = true), w("5", app, "com.android.settings"))
        assertEquals("com.android.systemui", pickForeground(shade, host)?.pkg)
    }

    @Test fun theHostsOwnActivityIsStillTheForegroundApp() {
        val ws = listOf(w("7", app, host, active = true, focused = true), w("5", app, "com.android.settings"))
        assertEquals(host, pickForeground(ws, host)?.pkg)
    }

    @Test fun keyboardDividerAndHostOverlaysOfOtherTypesNeverAre() {
        assertFalse(canBeForeground(ime, "com.android.inputmethod.latin", host))
        assertFalse(canBeForeground(overlay, "com.other.reader", host))
        assertFalse(canBeForeground(divider, "com.android.systemui", host))
        assertFalse(canBeForeground(system, host, host)) // the host's TYPE_APPLICATION_OVERLAY window
        assertFalse(canBeForeground(app, null, host))
        assertTrue(canBeForeground(app, host, host))
        assertTrue(canBeForeground(system, "com.android.systemui", host))
        val ws = listOf(w("2", ime, "com.android.inputmethod.latin", focused = true), w("5", app, "com.android.settings"))
        assertEquals("5", pickForeground(ws, host)?.id)
        assertNull(pickForeground(listOf(w("9", overlay, host, active = true)), host))
    }

    @Test fun theKeyboardShowingOrHidingLeavesRefsAlone() {
        val log = ChangeLog()
        fun see(vararg ws: Pair<String, Int>) = log.windows(ws.filter { countsForChanges(it.second) }.map { "${it.first}/${it.second}" })
        see("5" to app, "3" to system)
        val v = log.version()
        see("5" to app, "3" to system, "2" to ime) // keyboard up
        see("5" to app, "3" to system, "2" to ime, "9" to overlay) // an overlay on top
        see("5" to app, "3" to system) // both gone
        assertFalse(log.changedSince(v, "5", Rect(0, 0, 10, 10)))
        see("5" to app, "3" to system, "6" to app) // a dialog: a real change
        assertTrue(log.changedSince(v, "5", Rect(0, 0, 10, 10)))
    }

    @Test fun aWindowStateChangeFromTheKeyboardOrAnOverlayIsNotAPageChange() {
        val imes = setOf("com.android.inputmethod.latin")
        assertFalse(stateChangeCounts(ime, "com.android.inputmethod.latin", imes))
        // Its event can arrive before the keyboard window is listed: the package still tells.
        assertFalse(stateChangeCounts(null, "com.android.inputmethod.latin", imes))
        assertFalse(stateChangeCounts(overlay, "com.other.reader", imes))
        assertTrue(stateChangeCounts(app, "com.android.settings", imes))
        assertTrue(stateChangeCounts(null, "com.android.settings", imes))
        assertTrue(stateChangeCounts(null, null, imes))
    }

    @Test fun touchesOnOverlaysAndHostWindowsAreOurs() {
        assertTrue(isOwnSurface(overlay, "com.other.reader", host))
        assertTrue(isOwnSurface(overlay, null, host))
        assertTrue(isOwnSurface(app, host, host))
        assertTrue(isOwnSurface(system, host, host))
        assertFalse(isOwnSurface(app, "com.android.settings", host))
        assertFalse(isOwnSurface(null, null, host))
    }

    @Test fun theSystemAnrDialogIsRecognizedByItsIdsOrItsWords() {
        // The AOSP dialog's buttons carry android:id/aerr_*; OEM builds may only translate the text.
        assertTrue(looksLikeAnr("", emptyList(), listOf("android:id/aerr_wait")))
        assertTrue(looksLikeAnr("", listOf("微信没有响应"), emptyList()))
        assertTrue(looksLikeAnr("", listOf("應用程式沒有回應"), emptyList()))
        assertTrue(looksLikeAnr("System UI isn't responding", emptyList(), emptyList()))
        assertTrue(looksLikeAnr("", listOf("応答していません"), emptyList()))
        assertTrue(looksLikeAnr("", listOf("응답 없음"), emptyList()))
        // An ordinary system window is not an ANR dialog.
        assertFalse(looksLikeAnr("微信", listOf("微信", "发送"), emptyList()))
        assertFalse(looksLikeAnr("", emptyList(), listOf("android:id/button1")))
    }

    @Test fun theAnrOwnerIsTheAppWindowBelowTheDialog() {
        // The dialog itself is the system's; the app it is about is the application window under it.
        val under = listOf(w("9", system, "android", active = true), w("5", app, "com.tencent.mm"))
        assertEquals("com.tencent.mm", anrOwner(under, 0, host))
        // Some builds let the dialog's root name the app directly.
        val own = listOf(w("9", system, "com.tencent.mm", active = true))
        assertEquals("com.tencent.mm", anrOwner(own, 0, host))
        // A host window below it is not the owner; neither is another system window.
        assertNull(anrOwner(listOf(w("9", system, "android", active = true), w("5", app, host)), 0, host))
        assertNull(anrOwner(listOf(w("9", system, "android", active = true), w("8", system, "com.android.systemui")), 0, host))
    }
}
