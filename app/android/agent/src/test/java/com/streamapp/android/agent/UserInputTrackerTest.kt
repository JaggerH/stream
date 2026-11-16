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
}
