package com.streamapp.android.agent

/** Stands in for the on-device recognizer in JVM tests: fixed lines, call counting. */
internal class FakeOcr(var lines: List<OcrText> = emptyList()) : OcrEngine {
    var calls = 0
        private set
    /** When set, [recognize] throws it (an engine that cannot run). */
    var failure: Exception? = null

    override fun recognize(jpeg: ByteArray): List<OcrText> {
        calls++
        failure?.let { throw it }
        return lines
    }
}
