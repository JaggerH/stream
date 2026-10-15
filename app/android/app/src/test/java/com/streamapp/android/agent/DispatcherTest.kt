package com.streamapp.android.agent

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class DispatcherTest {
    private lateinit var dev: FakeDevice
    private lateinit var d: Dispatcher
    private val search = FakeNode("Button", "搜索", rect = Rect(100, 200, 50, 40))
    private val input = FakeNode("EditText", "搜索商家或商品", text = "")

    private fun call(op: String, args: String = "{}") = d.dispatch(op, JSONObject(args))
    @Suppress("UNCHECKED_CAST") private fun map(v: Any?) = v as Map<String, Any?>

    @Before fun setUp() {
        dev = FakeDevice()
        dev.roots["1"] = FakeNode("FrameLayout", children = listOf(input, search), rect = Rect(0, 0, 1080, 2400))
        d = Dispatcher(dev)
    }

    @Test fun declaresExactlyTheSixteenOps() {
        assertEquals(
            setOf("windows", "scopeWindow", "focusApp", "find", "invoke", "setValue", "type", "clearInput", "click", "scroll", "press", "readSubtree", "screenshot", "url", "sleep", "status"),
            ANDROID_OPS.toSet(),
        )
        assertEquals(16, ANDROID_OPS.size)
    }

    @Test fun findNeedsAScope() {
        val e = assertThrows(AgentError::class.java) { call("find", """{"query":{"role":"Button"}}""") }
        assertTrue(e.message!!.startsWith("no-scope:"))
    }

    @Test fun scopeThenFindThenInvoke() {
        call("scopeWindow", """{"match":{"process":"COM.SANKUAI.MEITUAN"}}""")
        val found = map(call("find", """{"query":{"role":"Button","name":"搜索"}}"""))
        @Suppress("UNCHECKED_CAST") val els = found["elements"] as List<Map<String, Any?>>
        assertEquals(1, els.size)
        assertEquals("Button", els[0]["role"])
        assertEquals(mapOf("x" to 100, "y" to 200, "w" to 50, "h" to 40), els[0]["rect"])
        assertFalse(found.containsKey("unbuilt"))
        val out = map(call("invoke", """{"ref":"${els[0]["ref"]}"}"""))
        assertEquals(mapOf("via" to "invoke"), out)
        assertTrue("click 搜索" in dev.log)
    }

    @Test fun aRefFromAnOlderFindIsStale() {
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
        @Suppress("UNCHECKED_CAST") val ref = (map(call("find", """{"query":{"role":"Button"}}"""))["elements"] as List<Map<String, Any?>>)[0]["ref"]
        call("find", """{"query":{"role":"EditText"}}""")
        assertThrows(StaleRefException::class.java) { call("invoke", """{"ref":"$ref"}""") }
    }

    @Test fun expectAddsConfirmedAndItsAbsenceDoesNot() {
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
        @Suppress("UNCHECKED_CAST") val ref = (map(call("find", """{"query":{"role":"Button"}}"""))["elements"] as List<Map<String, Any?>>)[0]["ref"]
        assertEquals(mapOf("via" to "invoke", "confirmed" to true), map(call("invoke", """{"ref":"$ref","expect":{"role":"EditText"}}""")))
        @Suppress("UNCHECKED_CAST") val ref2 = (map(call("find", """{"query":{"role":"Button"}}"""))["elements"] as List<Map<String, Any?>>)[0]["ref"]
        assertEquals(mapOf("via" to "invoke", "confirmed" to false), map(call("invoke", """{"ref":"$ref2","expect":{"name":"不存在"}}""")))
    }

    @Test fun emptyResultInABackgroundWindowCarriesUnbuilt() {
        dev.wins = mutableListOf(WindowInfo("1", "com.sankuai.meituan", "美团", false))
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
        val r = map(call("find", """{"query":{"role":"Switch"}}"""))
        assertTrue((r["unbuilt"] as String).startsWith("a11y-unbuilt:"))
    }

    @Test fun ambiguousAndMissingWindows() {
        dev.wins = mutableListOf(WindowInfo("1", "p", "A", true), WindowInfo("2", "p", "B", false))
        assertTrue(assertThrows(AgentError::class.java) { call("scopeWindow", """{"match":{"process":"p"}}""") }.message!!.startsWith("ambiguous-window:"))
        assertTrue(assertThrows(AgentError::class.java) { call("scopeWindow", """{"match":{"process":"q"}}""") }.message!!.startsWith("no-window-match:"))
        assertEquals("2", map(call("scopeWindow", """{"match":{"process":"p","title":"B"}}"""))["window"].let { (it as Map<*, *>)["id"] })
    }

    @Test fun typeAppendsToTheFocusedInput() {
        dev.focused = FakeNode("EditText", "框", text = "麦")
        assertEquals(mapOf("via" to "value"), map(call("type", """{"text":"当劳"}""")))
        assertTrue("setText 框=麦当劳" in dev.log)
    }

    @Test fun messageDeliveryIsRefused() {
        assertTrue(assertThrows(AgentError::class.java) { call("type", """{"text":"x","deliver":"message"}""") }.message!!.startsWith("unsupported-deliver:"))
    }

    @Test fun clickTapsTheCentreAndRightIsLongPress() {
        call("click", """{"rect":{"x":100,"y":200,"w":50,"h":40}}""")
        call("click", """{"rect":{"x":0,"y":0,"w":10,"h":10},"button":"right"}""")
        assertTrue("tap 125,220 long=false" in dev.log)
        assertTrue("tap 5,5 long=true" in dev.log)
    }

    @Test fun scrollDownSwipesUpOverTheScreen() {
        call("scroll", """{"dir":"down","amount":1}""")
        assertTrue("swipe 540,1680->540,720" in dev.log)
    }

    @Test fun pressMapsKeys() {
        call("press", """{"key":"Back"}""")
        call("press", """{"key":"Home"}""")
        assertEquals(listOf("back", "home"), dev.log.filter { it == "back" || it == "home" })
        assertTrue(assertThrows(AgentError::class.java) { call("press", """{"key":"Escape"}""") }.message!!.startsWith("unsupported-key:"))
    }

    @Test fun screenshotIsBase64Jpeg() {
        val r = map(call("screenshot"))
        assertEquals("AQID", r["base64"])
        assertEquals(mapOf("x" to 0, "y" to 0, "w" to 1080, "h" to 2400), r["window"])
        assertEquals(2.75, r["scale"])
    }

    @Test fun lockedDeviceFailsBeforeActing() {
        dev.locked = true
        assertTrue(assertThrows(AgentError::class.java) { call("click", """{"rect":{"x":0,"y":0,"w":2,"h":2}}""") }.message!!.startsWith("device-locked:"))
        assertFalse(dev.log.any { it.startsWith("tap") })
        assertEquals(emptyMap<String, Any?>(), map(call("status", """{"text":"下单中"}""")))
    }

    @Test fun focusAppWaitsForForeground() {
        dev.fg = "com.android.launcher"
        dev.launchMakesForeground = "me.ele"
        dev.wins = mutableListOf(WindowInfo("9", "me.ele", "饿了么", true))
        assertEquals(mapOf("ok" to true), call("focusApp", """{"match":{"process":"me.ele"}}"""))
        dev.roots["9"] = FakeNode("FrameLayout", children = listOf(FakeNode("Button", "下单")))
        @Suppress("UNCHECKED_CAST")
        assertEquals(listOf("下单"), (map(call("find", """{"query":{"role":"Button"}}"""))["elements"] as List<Map<String, Any?>>).map { it["name"] })
    }

    @Test fun focusAppDropsTheOldScopeWhenTheNewWindowIsNotFound() {
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
        dev.launchMakesForeground = "me.ele"
        call("focusApp", """{"match":{"process":"me.ele"}}""")
        // The scope is now me.ele (which has no window yet), not the old meituan window.
        val msg = assertThrows(AgentError::class.java) { call("find", """{"query":{"role":"Button"}}""") }.message!!
        assertTrue(msg, msg.startsWith("no-window-match:") && msg.contains("me.ele"))
    }

    @Test fun scopeSurvivesTheAppReplacingItsWindow() {
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
        call("find", """{"query":{"role":"Button"}}""")
        dev.wins = mutableListOf(WindowInfo("7", "com.sankuai.meituan", "美团", true))
        dev.roots.remove("1")
        dev.roots["7"] = FakeNode("FrameLayout", children = listOf(FakeNode("Button", "新页面")))
        @Suppress("UNCHECKED_CAST")
        assertEquals(listOf("新页面"), (map(call("find", """{"query":{"role":"Button"}}"""))["elements"] as List<Map<String, Any?>>).map { it["name"] })
    }

    @Test fun scopedAppWithNoWindowFailsLoudly() {
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
        dev.wins = mutableListOf()
        val msg = assertThrows(AgentError::class.java) { call("find", """{"query":{"role":"Button"}}""") }.message!!
        assertTrue(msg, msg.startsWith("no-window-match:") && msg.contains("com.sankuai.meituan"))
    }

    @Test fun scopePrefersTheForegroundWindowOfTheApp() {
        dev.wins = mutableListOf(WindowInfo("1", "com.sankuai.meituan", "美团", false), WindowInfo("2", "com.sankuai.meituan", "美团", true))
        dev.roots["2"] = FakeNode("FrameLayout", children = listOf(FakeNode("Button", "前台")))
        // Two windows match: scopeWindow itself refuses, so scope by title first, then check re-resolve prefers foreground.
        call("focusApp", """{"match":{"process":"com.sankuai.meituan"}}""")
        @Suppress("UNCHECKED_CAST")
        assertEquals(listOf("前台"), (map(call("find", """{"query":{"role":"Button"}}"""))["elements"] as List<Map<String, Any?>>).map { it["name"] })
    }

    @Test fun scrollUsesTheScopedWindowBoundsWithoutSnapshotting() {
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
        dev.bounds["1"] = Rect(0, 100, 1000, 1000)
        dev.roots.remove("1")
        call("scroll", """{"dir":"down","amount":1}""")
        assertTrue(dev.log.toString(), "swipe 500,800->500,400" in dev.log)
    }

    @Test fun focusAppThatNeverComesToTheFrontIsBlockedByOs() {
        dev.fg = "com.android.launcher"
        val msg = assertThrows(AgentError::class.java) { call("focusApp", """{"match":{"process":"me.ele"}}""") }.message!!
        assertTrue(msg, msg.startsWith("blocked-by-os:") && msg.contains("me.ele"))
        assertEquals(25, dev.log.count { it == "sleep 200" })
    }

    @Test fun hyperOsAskingToAllowTheLaunchSaysWhereToTap() {
        dev.fg = "com.miui.securitycenter"
        dev.component = "com.miui.securitycenter/com.miui.wakepath.ui.ConfirmStartActivity" // 「Stream 想要打开 饿了么，是否允许？」
        val msg = assertThrows(AgentError::class.java) { call("focusApp", """{"match":{"process":"me.ele"}}""") }.message!!
        assertTrue(msg, msg.startsWith("blocked-by-os:") && msg.contains("始终允许") && !msg.contains("后台弹出界面"))
    }

    @Test fun anotherSecurityCenterScreenIsNotTheLaunchPrompt() {
        dev.fg = "com.miui.securitycenter"
        dev.component = "com.miui.securitycenter/com.miui.securityscan.MainActivity" // 手机管家 itself
        val msg = assertThrows(AgentError::class.java) { call("focusApp", """{"match":{"process":"me.ele"}}""") }.message!!
        assertFalse(msg, msg.contains("始终允许"))
    }

    @Test fun aKeyTheSystemRefusesFails() {
        val refusing = object : Device by dev { override fun globalBack() = false }
        assertTrue(assertThrows(AgentError::class.java) { Dispatcher(refusing).dispatch("press", JSONObject("""{"key":"Back"}""")) }.message!!.startsWith("action-failed:"))
    }

    @Test fun unknownOpAndMissingArg() {
        assertEquals("unknown op: readText", assertThrows(AgentError::class.java) { call("readText") }.message)
        assertEquals("missing arg: ref", assertThrows(AgentError::class.java) { call("invoke") }.message)
    }

    private fun firstRef(query: String): String {
        @Suppress("UNCHECKED_CAST")
        return (map(call("find", """{"query":$query}"""))["elements"] as List<Map<String, Any?>>)[0]["ref"] as String
    }

    @Test fun aRefIsStaleAfterAWindowChange() {
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
        val ref = firstRef("""{"role":"Button"}""")
        dev.windowChanged()
        val e = assertThrows(StaleRefException::class.java) { call("invoke", """{"ref":"$ref"}""") }
        assertTrue(e.message!!.startsWith("stale-ref:"))
        assertFalse(dev.log.toString(), dev.log.any { it.startsWith("click") })
    }

    @Test fun aScrollOverTheRefStalesIt() {
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
        val ref = firstRef("""{"role":"Button"}""")
        dev.scrolled("1", Rect(0, 0, 1080, 2400))
        assertThrows(StaleRefException::class.java) { call("invoke", """{"ref":"$ref"}""") }
        assertFalse(dev.log.any { it.startsWith("click") })
    }

    @Test fun aCarouselScrollingElsewhereLeavesTheRefUsable() {
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
        val ref = firstRef("""{"role":"Button"}""") // at (100,200) 50x40
        dev.scrolled("1", Rect(0, 1000, 1080, 300))
        dev.scrolled("2", Rect(0, 0, 1080, 2400)) // another window scrolling over the same spot
        call("invoke", """{"ref":"$ref"}""")
        assertTrue("click 搜索" in dev.log)
    }

    @Test fun aRefIsStaleAfterTheScopeChanges() {
        dev.wins = mutableListOf(WindowInfo("1", "com.sankuai.meituan", "美团", true), WindowInfo("2", "me.ele", "饿了么", false))
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
        val ref = firstRef("""{"role":"EditText"}""")
        call("scopeWindow", """{"match":{"process":"me.ele"}}""")
        assertThrows(StaleRefException::class.java) { call("setValue", """{"ref":"$ref","text":"x"}""") }
        assertFalse(dev.log.toString(), dev.log.any { it.startsWith("setText") })
    }

    @Test fun aRefIsStaleWhenTheScopedWindowWasReplaced() {
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
        val ref = firstRef("""{"role":"Button"}""")
        dev.wins = mutableListOf(WindowInfo("7", "com.sankuai.meituan", "美团", true))
        assertThrows(StaleRefException::class.java) { call("invoke", """{"ref":"$ref"}""") }
        assertFalse(dev.log.any { it.startsWith("click") })
    }

    @Test fun aRefIsStaleWhenItsNodeNowShowsSomethingElse() {
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
        val ref = firstRef("""{"role":"Button"}""")
        dev.changed += search // a recycled list row: same view, another item
        assertThrows(StaleRefException::class.java) { call("invoke", """{"ref":"$ref"}""") }
        assertFalse(dev.log.any { it.startsWith("click") })
    }

    @Test fun aRefStaysUsableWhileTheTreeHoldsStill() {
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
        val input = firstRef("""{"role":"EditText"}""")
        call("setValue", """{"ref":"$input","text":"麦当劳"}""")
        call("setValue", """{"ref":"$input","text":"肯德基"}""")
        assertTrue("setText 搜索商家或商品=肯德基" in dev.log)
    }

    @Test fun abortAfterTheFirstSwipeStopsTheScroll() {
        val cancel = Cancel()
        dev.after = { if (it.startsWith("swipe")) cancel.cancel() }
        val e = assertThrows(AgentError::class.java) { d.dispatch("scroll", JSONObject("""{"dir":"down","amount":10}"""), cancel) }
        assertTrue(e.message!!, e.message!!.startsWith("aborted:"))
        assertEquals(1, dev.log.count { it.startsWith("swipe") })
    }

    @Test fun abortWhileWakingStopsTheTap() {
        val cancel = Cancel()
        dev.after = { if (it == "awake") cancel.cancel() }
        assertThrows(AgentError::class.java) { d.dispatch("click", JSONObject("""{"rect":{"x":0,"y":0,"w":2,"h":2}}"""), cancel) }
        assertFalse(dev.log.any { it.startsWith("tap") })
    }

    @Test fun abortDuringALongSleepEndsItEarly() {
        val cancel = Cancel()
        var slept = 0
        dev.after = { if (it.startsWith("sleep") && ++slept == 2) cancel.cancel() }
        assertThrows(AgentError::class.java) { d.dispatch("sleep", JSONObject("""{"ms":30000}"""), cancel) }
        assertEquals(2, slept)
    }

    @Test fun aCancelledTokenDoesNothingAtAll() {
        val cancel = Cancel().also { it.cancel() }
        assertThrows(AgentError::class.java) { d.dispatch("press", JSONObject("""{"key":"Home"}"""), cancel) }
        assertTrue(dev.log.toString(), dev.log.isEmpty())
    }

    @Test fun urlAndSleep() {
        assertEquals("com.sankuai.meituan/.Main", call("url"))
        assertNull(call("sleep", """{"ms":20}"""))
        assertTrue("sleep 20" in dev.log)
    }
}
