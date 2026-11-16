package com.streamapp.android.policy

import org.junit.Assert.assertTrue
import org.junit.Test

/** A wiring guard: the sensitive checks are only as good as their enforcement point, and the
 *  one production construction site of [com.streamapp.android.agent.Dispatcher] must pass the
 *  policy engine. The constructor's null default exists for JVM tests; this keeps it there. */
class PolicyWiringTest {
    @Test fun theRelayServiceWiresThePolicyEngineIntoEveryDispatcher() {
        val src = java.io.File("src/main/java/com/streamapp/android/net/RelayService.kt").readText()
        assertTrue("RelayService must load the policy tables (PolicyContext.fromStreams)", src.contains("PolicyContext.fromStreams"))
        assertTrue("RelayService must construct every Dispatcher with the policy engine", src.contains("Dispatcher(device, policy, occupancy)"))
    }

    /** The same guard for the embedding hooks: the occupancy hook reads the live `StreamAgent`
     *  settings per op, and the indicator's Stop goes through the abort-then-listener path. */
    @Test fun theRelayServiceWiresTheEmbeddingHooks() {
        val src = java.io.File("src/main/java/com/streamapp/android/net/RelayService.kt").readText()
        assertTrue(src.contains("Occupancy(hint = { StreamAgent.occupancyHint }, anyRecentTouch = { StreamAgent.anyRecentTouchOccupies })"))
        assertTrue(src.contains("AndroidDevice(this) { StreamAgent.userStopped { client?.abort() } }"))
    }
}
