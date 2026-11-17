package com.streamapp.android.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class UserInputTrackerTest {
    private val t = UserInputTracker()

    @Test fun noFactUntilATouchIsSeen() {
        assertNull(t.lastUserInputMs())
        t.onTouchInteraction(1_000)
        assertEquals(1_000L, t.lastUserInputMs())
    }

    @Test fun aTouchDuringOurOwnGestureDoesNotCount() {
        t.gestureDispatched(nowMs = 10_000, durationMs = 300)
        t.onTouchInteraction(10_050)
        t.onTouchInteraction(10_300)
        assertNull(t.lastUserInputMs())
    }

    @Test fun stragglersShortlyAfterTheGestureStillCountAsOurs() {
        t.gestureDispatched(nowMs = 10_000, durationMs = 300)
        t.onTouchInteraction(12_200) // within the margin past the gesture's own end
        assertNull(t.lastUserInputMs())
        t.onTouchInteraction(12_201 + 2_000)
        assertEquals(14_201L, t.lastUserInputMs())
    }

    @Test fun aHumanTouchAfterOurGestureCounts() {
        t.gestureDispatched(nowMs = 10_000, durationMs = 300)
        t.onTouchInteraction(60_000)
        assertEquals(60_000L, t.lastUserInputMs())
    }

    @Test fun theLatestTouchWins() {
        t.onTouchInteraction(1_000)
        t.onTouchInteraction(2_000)
        assertEquals(2_000L, t.lastUserInputMs())
    }

    @Test fun aTouchTheServiceAttributesToAnOverlayOrTheHostDoesNotCount() {
        t.onTouchInteraction(1_000, ownSurface = true)
        assertNull(t.lastUserInputMs())
    }

    @Test fun anOverlayReportingItsTouchTakesBackTheEventThatCameFirst() {
        t.onTouchInteraction(1_000)
        t.onTouchInteraction(20_000)
        t.ownSurfaceTouched(20_040)
        // The touch at 20 000 was on the overlay; the one before it still stands.
        assertEquals(1_000L, t.lastUserInputMs())
    }

    @Test fun theEventArrivingAfterTheOverlayReportedItDoesNotCount() {
        t.ownSurfaceTouched(5_000)
        t.onTouchInteraction(5_030)
        assertNull(t.lastUserInputMs())
        // A touch on the app well after the overlay touch counts again.
        t.onTouchInteraction(5_000 + UserInputTracker.OWN_TOUCH_SKEW_MS + 1)
        assertEquals(6_001L, t.lastUserInputMs())
    }

    @Test fun anOverlayTouchLongAfterAUserTouchLeavesItAlone() {
        t.onTouchInteraction(1_000)
        t.ownSurfaceTouched(9_000)
        assertEquals(1_000L, t.lastUserInputMs())
    }
}
