package com.streamapp.android.agent

import com.streamapp.android.AgentIndicator
import com.streamapp.android.IndicatorBounds
import com.streamapp.android.UserStopListener
import org.junit.Assert.*
import org.junit.Test

class IndicatorSlotTest {
    private class FakeIndicator(
        val hides: Boolean = true,
        val at: IndicatorBounds? = IndicatorBounds(0, 0, 1080, 96),
    ) : AgentIndicator {
        val log = mutableListOf<String>()
        override fun show(text: String?) { log += "show $text" }
        override fun passThrough(on: Boolean) { log += "pass $on" }
        override fun hideForCapture(hidden: Boolean): Boolean { log += "hide $hidden"; return hides }
        override fun bounds(): IndicatorBounds? = at
        override fun dispose() { log += "dispose" }
    }

    /** An indicator that only implements the original three members. */
    private class MinimalIndicator : AgentIndicator {
        override fun show(text: String?) {}
        override fun passThrough(on: Boolean) {}
        override fun dispose() {}
    }

    @Test fun theHostProviderIsBuiltOnceAndReusedForTheSameServiceAndProvider() {
        val slot = IndicatorSlot<Any>()
        val svc = Any()
        val provider = Any()
        var built = 0
        val a = slot.obtain(svc, provider) { built++; FakeIndicator() }
        val b = slot.obtain(svc, provider) { built++; FakeIndicator() }
        assertSame(a, b)
        assertEquals(1, built)
        assertSame(a, slot.sync(svc, provider))
    }

    @Test fun aSwappedProviderOrServiceDisposesTheOldIndicator() {
        val slot = IndicatorSlot<Any>()
        val svc = Any()
        val first = FakeIndicator()
        slot.obtain(svc, "default") { first }
        val second = FakeIndicator()
        assertSame(second, slot.obtain(svc, "host") { second })
        assertEquals(listOf("dispose"), first.log)
        // The service died: gone, and nothing to build on.
        assertNull(slot.sync(null, "host"))
        assertEquals(listOf("dispose"), second.log)
        assertNull(slot.obtain(null, "host") { fail("no service, no indicator"); FakeIndicator() })
    }

    @Test fun aScreenshotHidesTheIndicatorAndRestoresIt() {
        val ind = FakeIndicator(hides = true)
        val masked = listOf(Rect(1, 2, 3, 4))
        var seen: List<Rect>? = null
        captureWithout(ind, masked) { areas -> ind.log += "shoot"; seen = areas }
        assertEquals(listOf("hide true", "shoot", "hide false"), ind.log)
        assertEquals(masked, seen)
    }

    @Test fun anIndicatorThatCannotHideIsBlankedByItsBounds() {
        val ind = FakeIndicator(hides = false, at = IndicatorBounds(0, 2304, 1080, 96))
        var seen: List<Rect>? = null
        captureWithout(ind, emptyList()) { seen = it }
        assertEquals(listOf(Rect(0, 2304, 1080, 96)), seen)
        // The minimal indicator neither hides nor knows its bounds: the frame is taken as is.
        captureWithout(MinimalIndicator(), emptyList()) { seen = it }
        assertEquals(emptyList<Rect>(), seen)
    }

    @Test fun theIndicatorComesBackEvenWhenTheCaptureFails() {
        val ind = FakeIndicator()
        assertThrows(AgentError::class.java) { captureWithout(ind, emptyList()) { throw AgentError("secure-window: x") } }
        assertEquals(listOf("hide true", "hide false"), ind.log)
    }

    @Test fun noIndicatorMeansAPlainCapture() {
        assertEquals(listOf(Rect(1, 1, 1, 1)), captureWithout(null, listOf(Rect(1, 1, 1, 1))) { it })
    }

    @Test fun stopAbortsFirstThenTellsTheHost() {
        val order = mutableListOf<String>()
        stopFromIndicator({ order += "abort" }, UserStopListener { order += "listener" })
        assertEquals(listOf("abort", "listener"), order)
    }

    @Test fun aThrowingOrMissingListenerDoesNotStopTheAbort() {
        var aborted = 0
        stopFromIndicator({ aborted++ }, UserStopListener { throw IllegalStateException("host bug") })
        stopFromIndicator({ aborted++ }, null)
        assertEquals(2, aborted)
    }
}
