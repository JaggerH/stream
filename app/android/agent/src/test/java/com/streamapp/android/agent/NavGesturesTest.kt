package com.streamapp.android.agent

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/** focusApp `fresh`, accessibility-first scrolling with a hardened gesture fallback, and the host
 *  app's own windows in `windows`. */
class NavGesturesTest {
    private lateinit var dev: FakeDevice
    private lateinit var d: Dispatcher

    private fun call(op: String, args: String = "{}") = d.dispatch(op, JSONObject(args))
    @Suppress("UNCHECKED_CAST") private fun map(v: Any?) = v as Map<String, Any?>
    @Suppress("UNCHECKED_CAST") private fun rows(v: Any?) = v as List<Map<String, Any?>>

    @Before fun setUp() {
        dev = FakeDevice()
        dev.roots["1"] = FakeNode("FrameLayout", rect = Rect(0, 0, 1080, 2400))
        d = Dispatcher(dev)
    }

    // ---- focusApp fresh ---------------------------------------------------------------

    @Test fun focusAppResumesByDefault() {
        dev.fg = "com.android.launcher"
        dev.launchMakesForeground = "me.ele"
        assertEquals(mapOf("ok" to true), call("focusApp", """{"match":{"process":"me.ele"}}"""))
        assertTrue(dev.log.toString(), "launch me.ele" in dev.log)
    }

    @Test fun focusAppFreshLaunchesWithTheTaskClearedAndSaysSo() {
        dev.fg = "com.android.launcher"
        dev.launchMakesForeground = "me.ele"
        assertEquals(mapOf("ok" to true, "fresh" to true), call("focusApp", """{"match":{"process":"me.ele"},"fresh":true}"""))
        assertTrue(dev.log.toString(), "launch me.ele fresh" in dev.log)
    }

    @Test fun freshFocusOfTheAppInFrontWaitsForTheWindowToChange() {
        // Already in front: "it is in front" is only true of the new page once the window set changed.
        var polls = 0
        dev.after = { if (it.startsWith("sleep") && ++polls == 3) dev.windowChanged() }
        assertEquals(mapOf("ok" to true, "fresh" to true),
            call("focusApp", """{"match":{"process":"com.sankuai.meituan"},"fresh":true}"""))
        assertEquals(3, dev.log.count { it == "sleep 200" })
    }

    @Test fun resumeFocusOfTheAppInFrontReturnsAtOnce() {
        call("focusApp", """{"match":{"process":"com.sankuai.meituan"}}""")
        assertEquals(0, dev.log.count { it.startsWith("sleep") })
    }

    @Test fun launchFlagsClearTheTaskOnlyWhenFresh() {
        val newTask = 0x10000000 // FLAG_ACTIVITY_NEW_TASK
        val clearTask = 0x00008000 // FLAG_ACTIVITY_CLEAR_TASK
        val resetIfNeeded = 0x00200000 // FLAG_ACTIVITY_RESET_TASK_IF_NEEDED
        assertEquals(newTask or resetIfNeeded, com.streamapp.android.a11y.launchFlags(false))
        assertEquals(newTask or clearTask, com.streamapp.android.a11y.launchFlags(true))
    }

    @Test fun capsAdvertiseAppLaunchV2() {
        assertEquals(2, ANDROID_CAPS.first { it.id == "app.launch" }.v)
        assertTrue(ANDROID_CAPS.filter { it.id != "app.launch" }.all { it.v == 1 })
    }

    // ---- scroll: accessibility first ---------------------------------------------------

    private fun page(vararg kids: UiNode) = FakeNode("FrameLayout", rect = Rect(0, 0, 1080, 2400), children = kids.toList())

    @Test fun scrollUsesTheLargestVisibleScrollableContainer() {
        val small = FakeNode("RecyclerView", "chips", rect = Rect(0, 200, 1080, 300), isScrollable = true)
        val big = FakeNode("RecyclerView", "list", rect = Rect(0, 500, 1080, 1800), isScrollable = true)
        dev.roots["1"] = page(small, big)
        val out = map(call("scroll", """{"dir":"down","amount":2}"""))
        assertEquals(listOf("scrollNode list forward", "scrollNode list forward"), dev.log.filter { it.startsWith("scrollNode") })
        assertFalse(dev.log.any { it.startsWith("swipe") })
        assertEquals("a11y", out["method"])
        assertEquals("a11y", out["via"])
        assertEquals(2, out["steps"])
        assertFalse(out.containsKey("end"))
    }

    @Test fun scrollUpScrollsBackward() {
        dev.roots["1"] = page(FakeNode("ScrollView", "s", rect = Rect(0, 0, 1080, 2400), isScrollable = true))
        call("scroll", """{"dir":"up","amount":1}""")
        assertTrue(dev.log.toString(), "scrollNode s backward" in dev.log)
    }

    @Test fun scrollSkipsHiddenAndSidewaysContainers() {
        val pager = FakeNode("ViewPager", "pager", rect = Rect(0, 0, 1080, 2400), isScrollable = true, scrollAxis = AXIS_HORIZONTAL)
        val hidden = FakeNode("RecyclerView", "hidden", rect = Rect(0, 0, 1080, 2400), isScrollable = true, isVisible = false)
        val list = FakeNode("RecyclerView", "list", rect = Rect(0, 300, 1080, 1000), isScrollable = true)
        dev.roots["1"] = page(pager, hidden, list)
        call("scroll", """{"dir":"down","amount":1}""")
        assertEquals(listOf("scrollNode list forward"), dev.log.filter { it.startsWith("scrollNode") })
    }

    @Test fun scrollContainerAreaCountsOnlyTheOnScreenPart() {
        // A long list mostly below the window loses to a smaller one fully on screen.
        val offscreen = FakeNode("RecyclerView", "long", rect = Rect(0, 2200, 1080, 5000), isScrollable = true)
        val onscreen = FakeNode("RecyclerView", "short", rect = Rect(0, 100, 1080, 800), isScrollable = true)
        assertEquals("short", scrollContainer(page(offscreen, onscreen), Rect(0, 0, 1080, 2400))?.name)
        assertNull(scrollContainer(page(FakeNode("TextView", "x")), Rect(0, 0, 1080, 2400)))
    }

    @Test fun aContainerRefusingALaterStepEndsTheScroll() {
        dev.roots["1"] = page(FakeNode("RecyclerView", "list", rect = Rect(0, 0, 1080, 2400), isScrollable = true))
        dev.scrollAnswers = mutableListOf(true, false)
        val out = map(call("scroll", """{"dir":"down","amount":5}"""))
        assertEquals(1, out["steps"])
        assertEquals(true, out["end"])
        assertEquals(2, dev.log.count { it.startsWith("scrollNode") })
        assertFalse(dev.log.any { it.startsWith("swipe") })
    }

    @Test fun aContainerRefusingTheFirstStepFallsBackToAGestureOverIt() {
        dev.roots["1"] = page(FakeNode("RecyclerView", "list", rect = Rect(0, 400, 1000, 1000), isScrollable = true))
        dev.scrollAnswers = mutableListOf(false)
        val out = map(call("scroll", """{"dir":"down","amount":1}"""))
        assertEquals("gesture", out["method"])
        assertEquals("refused", out["a11y"])
        // Inside the container: x = 1000 - 132, y from 400 + 700 to 400 + 300.
        assertTrue(dev.log.toString(), "swipe 868,1100->868,700 hold=100" in dev.log)
    }

    @Test fun scrollInTheScopedWindowUsesThatWindowsTree() {
        dev.wins = mutableListOf(WindowInfo("1", "com.sankuai.meituan", "美团", false), WindowInfo("2", "me.ele", "饿了么", true))
        dev.roots["1"] = page(FakeNode("RecyclerView", "mine", rect = Rect(0, 0, 1080, 2400), isScrollable = true))
        dev.roots["2"] = page(FakeNode("RecyclerView", "theirs", rect = Rect(0, 0, 1080, 2400), isScrollable = true))
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
        call("scroll", """{"dir":"down","amount":1}""")
        assertEquals(listOf("scrollNode mine forward"), dev.log.filter { it.startsWith("scrollNode") })
    }

    // ---- gesture fallback hardening -----------------------------------------------------

    @Test fun swipeGeometryRunsInTheEdgeBand() {
        val g = swipeGeometry(Rect(0, 0, 1080, 2400), forward = true, touchSlop = 22, density = 2.75f)
        assertEquals(SwipeGeometry(948, 1680, 720), g)
        assertEquals(SwipeGeometry(948, 720, 1680), swipeGeometry(Rect(0, 0, 1080, 2400), false, 22, 2.75f))
    }

    @Test fun aNarrowAreaKeepsTheSwipeInsideIt() {
        // The band would put x left of the centre: stay at the centre instead, never outside.
        val g = swipeGeometry(Rect(100, 0, 200, 1000), true, 22, 2.75f)
        assertEquals(200, g.x)
    }

    @Test fun aSwipeTooShortForTheSlopIsRefused() {
        // 40% of 200 px = 80 px < 4 x 22 px.
        val e = assertThrows(AgentError::class.java) { swipeGeometry(Rect(0, 0, 1080, 200), true, 22, 2.75f) }
        assertTrue(e.message!!, e.message!!.startsWith("action-failed:"))
        assertEquals(SwipeGeometry(948, 70, 30), swipeGeometry(Rect(0, 0, 1080, 100), true, 10, 2.75f))
    }

    @Test fun aRefusedSwipeTouchesNothing() {
        dev.wins = mutableListOf(WindowInfo("1", "com.sankuai.meituan", "美团", true))
        dev.roots.remove("1")
        dev.bounds["1"] = Rect(0, 0, 1080, 150)
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
        val e = assertThrows(AgentError::class.java) { call("scroll", """{"dir":"down","amount":3}""") }
        assertTrue(e.message!!.startsWith("action-failed:"))
        assertFalse(dev.log.any { it.startsWith("swipe") })
    }

    // ---- the host's own window ------------------------------------------------------------

    private val host = WindowInfo("5", "com.example.host", "Host", true, self = true)

    @Test fun windowsListsTheHostRowMarkedSelf() {
        dev.wins = mutableListOf(WindowInfo("1", "com.sankuai.meituan", "美团", false), host)
        val out = rows(call("windows"))
        assertEquals(2, out.size)
        assertFalse(out[0].containsKey("self"))
        assertEquals(mapOf("id" to "5", "process" to "com.example.host", "title" to "Host", "foreground" to true, "self" to true), out[1])
    }

    @Test fun theHostWindowCannotBeScoped() {
        dev.wins = mutableListOf(host)
        dev.roots["5"] = page(FakeNode("Button", "secret"))
        val e = assertThrows(AgentError::class.java) { call("scopeWindow", """{"match":{"process":"com.example.host"}}""") }
        assertTrue(e.message!!, e.message!!.startsWith("no-window-match:"))
    }

    @Test fun anUnscopedScrollNeverTargetsTheHostWindow() {
        dev.wins = mutableListOf(host, WindowInfo("1", "com.sankuai.meituan", "美团", false))
        dev.roots["5"] = page(FakeNode("RecyclerView", "host-list", rect = Rect(0, 0, 1080, 2400), isScrollable = true))
        dev.roots["1"] = page(FakeNode("RecyclerView", "bg-list", rect = Rect(0, 0, 1080, 2400), isScrollable = true))
        val out = map(call("scroll", """{"dir":"down","amount":1}"""))
        // Neither the host's list nor a background window's: no window of ours is in front.
        assertFalse(dev.log.any { it.startsWith("scrollNode") })
        assertEquals("gesture", out["method"])
    }
}
