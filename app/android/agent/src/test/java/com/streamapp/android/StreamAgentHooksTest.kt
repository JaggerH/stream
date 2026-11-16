package com.streamapp.android

import org.junit.After
import org.junit.Assert.*
import org.junit.Test

class StreamAgentHooksTest {
    @After fun reset() {
        StreamAgent.userStopListener = null
        StreamAgent.occupancyHint = null
        StreamAgent.anyRecentTouchOccupies = false
        StreamAgent.indicatorProvider = StreamAgent.defaultIndicator
    }

    @Test fun defaultsKeepTheAgentsOwnBehaviour() {
        assertSame(StreamAgent.defaultIndicator, StreamAgent.indicatorProvider)
        assertNull(StreamAgent.occupancyHint)
        assertFalse(StreamAgent.anyRecentTouchOccupies)
        assertNull(StreamAgent.userStopListener)
    }

    @Test fun theIndicatorsStopSendsTheAbortAndThenCallsTheHostsListener() {
        val order = mutableListOf<String>()
        StreamAgent.userStopListener = UserStopListener { order += "listener" }
        StreamAgent.userStopped { order += "abort" }
        assertEquals(listOf("abort", "listener"), order)
        // Without a listener the abort still goes out.
        StreamAgent.userStopListener = null
        StreamAgent.userStopped { order += "abort" }
        assertEquals(listOf("abort", "listener", "abort"), order)
    }
}
