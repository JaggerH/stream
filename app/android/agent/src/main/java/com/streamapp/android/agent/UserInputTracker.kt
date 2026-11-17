package com.streamapp.android.agent

/**
 * Touch facts the accessibility service observes, minus what the executor itself injected and
 * minus touches on the agent's or the host's own surfaces.
 *
 * The service sees every touch interaction on the screen — including the gestures the dispatcher
 * injects through `dispatchGesture`, which the system reports like real touches. The tracker is
 * told when a gesture goes out and keeps counting only inputs that arrive outside that window
 * (the gesture's duration plus a margin, so stragglers the system delivers late still count as
 * ours). A touch on an accessibility overlay or a window of the host app (the indicator, a panel
 * the host draws over the screen) is not the user using the app in front either: the service says
 * so when the event names such a window, and the overlay itself reports its own touches through
 * [ownSurfaceTouched] — the event and the overlay's touch arrive in either order, so each cancels
 * the other within [OWN_TOUCH_SKEW_MS]. What is left is what a human touched in the app in front:
 * the fact `app-in-use` judges on.
 */
internal class UserInputTracker {
    @Volatile private var ownGestureUntilMs = 0L
    @Volatile private var ownTouchUntilMs = 0L
    @Volatile private var lastInput: Long? = null
    /** What [lastInput] was before its latest update: restored when that update turns out to be
     *  a touch on our own surface. */
    @Volatile private var previousInput: Long? = null

    /** The most recent human touch, epoch ms; null when none was observed. */
    fun lastUserInputMs(): Long? = lastInput

    /** A gesture of [durationMs] went out at [nowMs]; touches until it ends (plus the margin) are ours. */
    fun gestureDispatched(nowMs: Long, durationMs: Long) {
        ownGestureUntilMs = nowMs + durationMs + OWN_GESTURE_MARGIN_MS
    }

    /** A touch interaction started at [nowMs]; [ownSurface] when the service could tell it landed on
     *  an overlay or a window of the host app. */
    @Synchronized fun onTouchInteraction(nowMs: Long, ownSurface: Boolean = false) {
        if (ownSurface) return
        // Within an injected gesture, or the late event of a touch an overlay already reported.
        if (nowMs < ownGestureUntilMs || nowMs < ownTouchUntilMs) return
        previousInput = lastInput
        lastInput = nowMs
    }

    /** The user touched one of our own surfaces (an overlay window the agent or the host shows) at
     *  [nowMs]. The service's event for the same touch may already have counted: it is taken back. */
    @Synchronized fun ownSurfaceTouched(nowMs: Long) {
        ownTouchUntilMs = nowMs + OWN_TOUCH_SKEW_MS
        val last = lastInput
        if (last != null && kotlin.math.abs(nowMs - last) <= OWN_TOUCH_SKEW_MS) lastInput = previousInput
    }

    companion object {
        /** Injected events can be delivered a beat after the gesture completes; keep counting
         *  them as ours for this long past the gesture's own duration. */
        const val OWN_GESTURE_MARGIN_MS = 2_000L
        /** How far apart an overlay's own touch and the service's event for it may arrive. */
        const val OWN_TOUCH_SKEW_MS = 1_000L
    }
}
