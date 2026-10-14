package com.streamapp.android.protocol

import org.junit.Assert.*
import org.junit.Test

class BackoffTest {
    @Test fun doublesUpToTheCapThenResets() {
        val b = Backoff(baseMs = 1000, capMs = 60_000, jitter = { 0.0 })
        assertEquals(listOf(1000L, 2000L, 4000L, 8000L, 16000L, 32000L, 60000L, 60000L), (1..8).map { b.next() })
        b.reset()
        assertEquals(1000L, b.next())
    }

    @Test fun jitterAddsUpToAQuarter() {
        val b = Backoff(baseMs = 1000, capMs = 60_000, jitter = { 1.0 })
        assertEquals(1250L, b.next())
    }
}
