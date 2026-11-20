package com.streamapp.android.agent

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * What a scroll that moved nothing says about itself. A step count alone cannot be told apart from
 * a device that scrolled: the receipt must name why the list did not move and, when the evidence
 * allows it, say the content is at its end — so the caller does not have to guess whether the page
 * is unscrollable or the accessibility action silently did nothing.
 */
class ScrollEndReceiptTest {
    private lateinit var dev: FakeDevice
    private lateinit var d: Dispatcher
    private var clock = 0L

    private fun call(op: String, args: String = "{}") = d.dispatch(op, JSONObject(args))
    @Suppress("UNCHECKED_CAST") private fun map(v: Any?) = v as Map<String, Any?>

    private fun page(vararg kids: UiNode) = FakeNode(
        "FrameLayout", className = "android.widget.FrameLayout", rect = Rect(0, 0, 1080, 2400), children = kids.toList(),
    )

    private fun list(name: String, y: Int = 0, h: Int = 2000, kids: List<UiNode> = emptyList(), scrollsForward: Boolean = true) =
        FakeNode(
            "RecyclerView", name, className = "androidx.recyclerview.widget.RecyclerView",
            rect = Rect(0, y, 1080, h), isScrollable = true, children = kids, scrollsForward = scrollsForward,
        )

    private fun row(name: String, y: Int) =
        FakeNode("TextView", name, className = "android.widget.TextView", rect = Rect(0, y, 1080, 200))

    @Before fun setUp() {
        dev = FakeDevice()
        d = Dispatcher(dev, settleTiming = FAST_SETTLE, now = { clock })
        // Every sleep costs its own duration, so the op's bounds can be asserted.
        dev.after = { s -> if (s.startsWith("sleep")) clock += s.removePrefix("sleep ").trim().toLong() }
    }

    // ---- a scroll without until ---------------------------------------------------------

    @Test fun anAcceptedActionThatMovesNothingEndsAfterTheGesture() {
        // The list accepts every accessibility scroll action and never moves; the fallback gesture
        // over the same area changes nothing either: there is nothing more this way.
        dev.roots["1"] = page(list("list", kids = listOf(row("商品 A", 100))))
        dev.inert += "list"
        val out = map(call("scroll", """{"dir":"down","amount":1}"""))
        assertEquals("gesture", out["method"])
        assertEquals("no-effect", out["a11y"])
        assertEquals(false, out["moved"])
        assertEquals(true, out["end"])
        assertEquals("gesture-no-effect", out["reason"])
        assertEquals(1, dev.log.count { it.startsWith("scrollNode") })
        assertEquals(1, dev.log.count { it.startsWith("swipe") })
        assertTrue("simulated op took $clock ms", clock <= 10_000)
    }

    @Test fun withoutAnyContainerTheReceiptSaysWhyItCouldNotTell() {
        // No scrollable node and the gesture changed nothing: "nothing moved" is all the agent
        // knows — claiming the end would be a guess, so the receipt says which case this is.
        dev.roots["1"] = page(FakeNode("TextView", "只有内容", rect = Rect(0, 100, 1080, 200)))
        val out = map(call("scroll", """{"dir":"down","amount":1}"""))
        assertEquals("gesture", out["method"])
        assertEquals(false, out["moved"])
        assertEquals("no-container", out["reason"])
        assertFalse(out.containsKey("end"))
        assertEquals(1, dev.log.count { it.startsWith("swipe") })
    }

    // ---- a scroll with until ------------------------------------------------------------

    /** The system-settings main list: an outer scroll view around a list that, at the bottom, no
     *  longer offers the forward action while the wrapper still takes it and moves nothing. */
    private fun settingsListAtItsEnd(vararg labels: String): UiNode {
        val rows = labels.mapIndexed { i, name -> row(name, 300 + i * 200) }
        val inner = list("list", y = 300, h = 2100, kids = rows, scrollsForward = false)
        val outer = FakeNode(
            "NestedScrollView", "page", className = "androidx.core.widget.NestedScrollView",
            rect = Rect(0, 0, 1080, 2400), isScrollable = true, children = listOf(inner),
        )
        return page(outer)
    }

    @Test fun untilStopsAtOnceWhenTheListNoLongerTakesTheDirection() {
        dev.roots["1"] = settingsListAtItsEnd("账号", "关于手机")
        dev.inert += "page" // the wrapper accepts the action and the list itself stays put
        val out = map(call("scroll", """{"dir":"down","amount":1,"until":"Android 版本","maxSteps":10,"timeoutMs":60000}"""))
        assertEquals(false, out["found"])
        assertEquals("one step is enough to hear the end", 1, out["scrolls"])
        assertEquals("end", out["stopped"])
        assertEquals(true, out["end"])
        assertEquals(false, out["moved"])
        assertEquals("container-at-end", out["reason"])
        // Only the outer wrapper was asked (and answered without moving); the list whose actions
        // are gone was never touched, and no gesture was spent.
        assertEquals(listOf("scrollNode page forward"), dev.log.filter { it.startsWith("scrollNode") })
        assertEquals(0, dev.log.count { it.startsWith("swipe") })
        assertEquals(setOf("a11yMs", "gestureMs", "settleMs", "changeCheckMs", "steps"), map(out["timing"]).keys)
        assertTrue("simulated op took $clock ms", clock <= 10_000)
    }

    @Test fun untilStopsAtOnceWhenNeitherTheActionNorTheGestureMovesTheList() {
        // The list still offers the forward action, accepts it and stays put; the gesture over it
        // changes nothing either — the second step would repeat the same answer.
        dev.roots["1"] = page(list("list", kids = listOf(row("商品 A", 100))))
        dev.inert += "list"
        val out = map(call("scroll", """{"dir":"down","amount":1,"until":"排序","maxSteps":10,"timeoutMs":60000}"""))
        assertEquals(false, out["found"])
        assertEquals(1, out["scrolls"])
        assertEquals("end", out["stopped"])
        assertEquals(true, out["end"])
        assertEquals(false, out["moved"])
        assertEquals("gesture-no-effect", out["reason"])
        assertTrue(dev.log.any { it.startsWith("swipe") })
    }

    @Test fun untilWithoutAContainerKeepsTheTwoUnchangedStepsRule() {
        // No container: one gesture that changes nothing cannot tell "end" from "missed", so the
        // documented two-unchanged-steps rule still ends the search — and says why.
        dev.roots["1"] = page(FakeNode("TextView", "只有内容", rect = Rect(0, 100, 1080, 200)))
        val out = map(call("scroll", """{"dir":"down","amount":1,"until":"排序","maxSteps":10,"timeoutMs":60000}"""))
        assertEquals(false, out["found"])
        assertEquals(2, out["scrolls"])
        assertEquals("end", out["stopped"])
        assertEquals(false, out["moved"])
        assertEquals("no-container", out["reason"])
    }

    @Test fun aSearchThatKeepsMovingKeepsItsOldReceiptShape() {
        dev.roots["1"] = page(list("list", kids = listOf(row("商品 A", 100))))
        val out = map(call("scroll", """{"dir":"down","amount":1,"until":"排序","maxSteps":3,"timeoutMs":60000}"""))
        assertEquals(false, out["found"])
        assertEquals(3, out["scrolls"])
        assertEquals("steps", out["stopped"])
        assertFalse(out.toString(), out.containsKey("moved"))
        assertFalse(out.toString(), out.containsKey("end"))
        assertFalse(out.toString(), out.containsKey("reason"))
        assertEquals(setOf("a11yMs", "gestureMs", "settleMs", "changeCheckMs", "steps"), map(out["timing"]).keys)
    }

    @Test fun aListThatDroppedTheDirectionSaysWhichEndItIs() {
        dev.roots["1"] = page(list("list", kids = listOf(row("商品 A", 100)), scrollsForward = false))
        val out = map(call("scroll", """{"dir":"down","amount":3}"""))
        assertEquals(0, out["steps"])
        assertEquals(true, out["end"])
        assertEquals(false, out["moved"])
        assertEquals("container-at-end", out["reason"])
        assertFalse(dev.log.any { it.startsWith("scrollNode") || it.startsWith("swipe") })
    }
}
