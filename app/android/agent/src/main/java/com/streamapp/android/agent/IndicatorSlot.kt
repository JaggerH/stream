package com.streamapp.android.agent

import com.streamapp.android.AgentIndicator
import com.streamapp.android.UserStopListener

/**
 * The one live indicator, bound to the accessibility service ([S]) it was drawn through and to
 * the provider that built it. A new service (the old one died) or a provider the host swapped in
 * disposes it; the next [obtain] builds a fresh one from the current provider. Plain Kotlin so the
 * rules are testable off-device.
 */
internal class IndicatorSlot<S : Any> {
    private var indicator: AgentIndicator? = null
    private var service: S? = null
    private var provider: Any? = null

    /** The indicator that is still valid for [liveService] and [liveProvider], or null; a stale one is disposed. */
    @Synchronized
    fun sync(liveService: S?, liveProvider: Any): AgentIndicator? {
        val current = indicator ?: return null
        if (liveService === service && liveProvider === provider) return current
        try { current.dispose() } catch (_: RuntimeException) { /* the host's indicator failing must not fail an op */ }
        indicator = null
        service = null
        provider = null
        return null
    }

    /** The valid indicator, built through [build] when there is none. Null without a service. */
    @Synchronized
    fun obtain(liveService: S?, liveProvider: Any, build: (S) -> AgentIndicator): AgentIndicator? {
        sync(liveService, liveProvider)?.let { return it }
        val s = liveService ?: return null
        return build(s).also {
            indicator = it
            service = s
            provider = liveProvider
        }
    }
}

/**
 * Takes a screenshot through [shoot] without the indicator in it: asks the indicator to step off
 * the screen, and when it cannot, blanks its bounds alongside [masked]. The indicator is always
 * told to come back, also when the capture fails. A failing indicator never fails the capture.
 */
internal fun <T> captureWithout(indicator: AgentIndicator?, masked: List<Rect>, shoot: (List<Rect>) -> T): T {
    if (indicator == null) return shoot(masked)
    val hidden = try { indicator.hideForCapture(true) } catch (_: RuntimeException) { false }
    try {
        val b = if (hidden) null else try { indicator.bounds() } catch (_: RuntimeException) { null }
        val areas = if (b == null || b.width <= 0 || b.height <= 0) masked else masked + Rect(b.left, b.top, b.width, b.height)
        return shoot(areas)
    } finally {
        try { indicator.hideForCapture(false) } catch (_: RuntimeException) { /* see above */ }
    }
}

/** The indicator's Stop: the abort goes out first, then the host is told. A listener that throws
 *  changes nothing about the abort. */
internal fun stopFromIndicator(abort: () -> Unit, listener: UserStopListener?) {
    try {
        abort()
    } finally {
        try { listener?.onUserStop() } catch (_: RuntimeException) { /* the host's problem, not the stop's */ }
    }
}
