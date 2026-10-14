package com.streamapp.android.protocol

/** Reconnect delays: doubling from [baseMs] to [capMs], plus up to 25% jitter so a backend
 *  restart does not get every phone back in the same millisecond. */
class Backoff(
    private val baseMs: Long = 1_000,
    private val capMs: Long = 60_000,
    private val jitter: () -> Double = { Math.random() },
) {
    private var attempt = 0

    fun next(): Long {
        val raw = (baseMs shl attempt.coerceAtMost(20)).coerceAtMost(capMs)
        if (raw < capMs) attempt++
        return raw + (raw * 0.25 * jitter()).toLong()
    }

    fun reset() { attempt = 0 }
}
