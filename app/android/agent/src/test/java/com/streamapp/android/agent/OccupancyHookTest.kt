package com.streamapp.android.agent

import com.streamapp.android.OccupancyHint
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** The embedding app's say in the occupancy check: `StreamAgent.occupancyHint` and the
 *  any-recent-touch policy, as the dispatcher reads them. */
class OccupancyHookTest {
    private val dev = FakeDevice()
    private var hint: OccupancyHint? = null
    private var anyTouch = false
    private val asked = mutableListOf<String>()
    private val d = Dispatcher(dev, occupancy = Occupancy(hint = { hint }, anyRecentTouch = { anyTouch }))

    private fun call(op: String, args: String = "{}") = d.dispatch(op, JSONObject(args))
    private fun hintSaying(vararg busy: String) = OccupancyHint { p -> asked += p; if (p in busy) true else null }

    @Test fun noHintAndPolicyOffIsTheAgentsOwnCheck() {
        dev.fg = "com.android.launcher"
        dev.userInputAt = System.currentTimeMillis()
        dev.launchMakesForeground = "me.ele"
        assertEquals(mapOf("ok" to true), call("focusApp", """{"match":{"process":"me.ele"}}"""))
    }

    @Test fun aHintOnTheTargetRefusesFocusAppWithoutATouch() {
        hint = hintSaying("me.ele")
        val e = assertThrows(AgentError::class.java) { call("focusApp", """{"match":{"process":"me.ele"}}""") }
        assertEquals("app-in-use", e.errorCode)
        assertEquals("focusApp", e.semantics!!.getString("op"))
        assertEquals("me.ele", e.semantics!!.getJSONObject("app").getString("id"))
        assertFalse(dev.log.any { it.startsWith("launch") })
    }

    @Test fun aHintOnTheAppInFrontRefusesTakingTheScreenFromIt() {
        // The embedding app is in front and says its user is busy in it.
        dev.fg = "com.example.host"
        hint = hintSaying("com.example.host")
        val e = assertThrows(AgentError::class.java) { call("focusApp", """{"match":{"process":"me.ele"}}""") }
        assertEquals("app-in-use", e.errorCode)
        assertEquals("com.example.host", e.semantics!!.getJSONObject("app").getString("id"))
        assertEquals(listOf("me.ele", "com.example.host"), asked)
        assertFalse(dev.log.any { it.startsWith("launch") })
    }

    @Test fun aHintRefusesActionOps() {
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
        hint = hintSaying("com.sankuai.meituan")
        val e = assertThrows(AgentError::class.java) { call("click", """{"rect":{"x":100,"y":200,"w":50,"h":40}}""") }
        assertEquals("app-in-use", e.errorCode)
        assertEquals("click", e.semantics!!.getString("op"))
        assertEquals("美团", e.semantics!!.getJSONObject("app").getString("name"))
        assertFalse(dev.log.any { it.startsWith("tap") })
        assertThrows(AgentError::class.java) { call("press", """{"key":"Back"}""") }
        assertFalse("back" in dev.log)
    }

    @Test fun aFalseOrNullOrThrowingHintLeavesTheDecisionToTheAgent() {
        dev.launchMakesForeground = "me.ele"
        hint = OccupancyHint { false }
        assertEquals(mapOf("ok" to true), call("focusApp", """{"match":{"process":"me.ele"}}"""))
        hint = OccupancyHint { throw IllegalStateException("host bug") }
        assertEquals(mapOf("ok" to true), call("focusApp", """{"match":{"process":"me.ele"}}"""))
        // The agent's own fact still refuses: a false hint does not override a fresh touch.
        hint = OccupancyHint { false }
        dev.fg = "me.ele"
        dev.userInputAt = System.currentTimeMillis()
        assertThrows(AgentError::class.java) { call("focusApp", """{"match":{"process":"me.ele"}}""") }
    }

    @Test fun readsAreNeverAskedAbout() {
        hint = hintSaying("com.sankuai.meituan")
        assertTrue(map(call("screenshot")).containsKey("base64"))
        call("windows")
        assertTrue(asked.isEmpty())
    }

    @Test fun anyRecentTouchPolicyRefusesWhateverIsInFront() {
        dev.fg = "com.android.launcher"
        dev.userInputAt = System.currentTimeMillis() - 2_000
        anyTouch = true
        val e = assertThrows(AgentError::class.java) { call("focusApp", """{"match":{"process":"me.ele"}}""") }
        assertEquals("app-in-use", e.errorCode)
        assertEquals("com.android.launcher", e.semantics!!.getJSONObject("app").getString("id"))
        assertFalse(dev.log.any { it.startsWith("launch") })
    }

    @Test fun anyRecentTouchPolicyLetsAnOldTouchOrNoTouchThrough() {
        dev.fg = "com.android.launcher"
        dev.launchMakesForeground = "me.ele"
        anyTouch = true
        assertEquals(mapOf("ok" to true), call("focusApp", """{"match":{"process":"me.ele"}}"""))
        dev.fg = "com.android.launcher"
        dev.userInputAt = System.currentTimeMillis() - 11_000
        assertEquals(mapOf("ok" to true), call("focusApp", """{"match":{"process":"me.ele"}}"""))
    }

    @Suppress("UNCHECKED_CAST") private fun map(v: Any?) = v as Map<String, Any?>
}
