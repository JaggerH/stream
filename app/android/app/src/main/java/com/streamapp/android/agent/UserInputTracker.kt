package com.streamapp.android.agent

/**
 * Touch facts the accessibility service observes, minus what the executor itself injected.
 *
 * The service sees every touch interaction on the screen — including the gestures the dispatcher
 * injects through `dispatchGesture`, which the system reports like real touches. The tracker is
 * told when a gesture goes out and keeps counting only inputs that arrive outside that window
 * (the gesture's duration plus a margin, so stragglers the system delivers late still count as
 * ours). What is left is what a human touched: the fact `app-in-use` judges on.
 */
class UserInputTracker {
    @Volatile private var ownGestureUntilMs = 0L
    @Volatile private var lastInput: Long? = null

    /** The most recent human touch, epoch ms; null when none was observed. */
    fun lastUserInputMs(): Long? = lastInput

    /** A gesture of [durationMs] went out at [nowMs]; touches until it ends (plus the margin) are ours. */
    fun gestureDispatched(nowMs: Long, durationMs: Long) {
        ownGestureUntilMs = nowMs + durationMs + OWN_GESTURE_MARGIN_MS
    }

    fun onTouchInteraction(nowMs: Long) {
        if (nowMs >= ownGestureUntilMs) lastInput = nowMs
    }

    companion object {
        /** Injected events can be delivered a beat after the gesture completes; keep counting
         *  them as ours for this long past the gesture's own duration. */
        const val OWN_GESTURE_MARGIN_MS = 2_000L
    }
}
