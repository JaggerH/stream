package com.streamapp.android.agent

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * `scroll` with `until`: it keeps scrolling while the wanted label is not on screen, and stops on
 * the first of three bounds — the end of the content (a step that says the list is at its end, else
 * two steps that leave the tree unchanged), `maxSteps`, or `timeoutMs` — reporting what it saw
 * rather than letting the caller's timeout expire.
 */
class ScrollUntilTest {
    private lateinit var dev: FakeDevice
    private lateinit var d: Dispatcher
    private var clock = 0L

    private fun call(op: String, args: String = "{}") = d.dispatch(op, JSONObject(args))
    @Suppress("UNCHECKED_CAST") private fun map(v: Any?) = v as Map<String, Any?>
    @Suppress("UNCHECKED_CAST") private fun list(v: Any?) = v as List<Any?>

    private fun frame(vararg kids: FakeNode) = FakeNode(
        "FrameLayout", className = "android.widget.FrameLayout", rect = Rect(0, 0, 1080, 2400), children = kids.toList(),
    )

    private fun feed(vararg kids: FakeNode) = FakeNode(
        "RecyclerView", "商品列表", className = "androidx.recyclerview.widget.RecyclerView",
        rect = Rect(0, 0, 1080, 2000), isScrollable = true, children = kids.toList(),
    )

    private fun label(name: String, y: Int = 100) =
        FakeNode("TextView", name, className = "android.widget.TextView", rect = Rect(0, y, 1080, 100))

    @Before fun setUp() {
        dev = FakeDevice()
        dev.roots["1"] = frame(feed(label("商品 A")))
        d = Dispatcher(dev, settleTiming = FAST_SETTLE, now = { clock })
    }

    @Test fun aLabelAlreadyOnScreenReturnsWithoutScrolling() {
        dev.roots["1"] = frame(label("排序", y = 300), feed(label("商品 A", y = 500)))
        val out = map(call("scroll", """{"dir":"down","amount":1,"until":"排序"}"""))
        assertEquals(true, out["found"])
        assertEquals(0, out["scrolls"])
        assertEquals("排序", map(out["match"])["name"])
        assertFalse(dev.log.toString(), dev.log.any { it.startsWith("scrollNode") || it.startsWith("swipe") })
    }

    @Test fun foundAfterTwoScrollsReportsTheMatch() {
        var steps = 0
        dev.after = { s ->
            if (s.startsWith("scrollNode")) {
                steps++
                if (steps == 2) dev.roots["1"] = frame(label("排序", y = 300), feed(label("商品 A", y = 500)))
            }
        }
        val out = map(call("scroll", """{"dir":"down","amount":1,"until":"排序","maxSteps":10,"timeoutMs":60000}"""))
        assertEquals(true, out["found"])
        assertEquals(2, out["scrolls"])
        val match = map(out["match"])
        assertEquals("排序", match["name"])
        assertEquals("TextView", match["role"])
        assertEquals("a11y", out["method"])
    }

    @Test fun theStepThatSaysTheListIsAtItsEndStopsAtOnce() {
        // The list accepts the action and never moves, and the fallback gesture over it does not
        // move the screen either: the first step already says this direction is exhausted, so a
        // second identical step would only repeat the answer.
        dev.scrollMoves = mutableListOf(false, false, false, false, false)
        val out = map(call("scroll", """{"dir":"down","amount":1,"until":"排序","maxSteps":10,"timeoutMs":60000}"""))
        assertEquals(false, out["found"])
        assertEquals(1, out["scrolls"])
        assertEquals("end", out["stopped"])
        // "Where it stopped": a few visible labels, never more than five, each bounded.
        val visible = list(out["visible"]).map { it as String }
        assertTrue(visible.isNotEmpty())
        assertTrue(visible.size <= 5)
        assertTrue(visible.all { it.length <= 64 })
        assertTrue(visible.any { it.contains("商品 A") })
    }

    @Test fun maxStepsStopsEvenWhenTheContentKeepsMoving() {
        val out = map(call("scroll", """{"dir":"down","amount":1,"until":"排序","maxSteps":3,"timeoutMs":60000}"""))
        assertEquals(false, out["found"])
        assertEquals(3, out["scrolls"])
        assertEquals("steps", out["stopped"])
        assertEquals(3, dev.log.count { it.startsWith("scrollNode") })
    }

    @Test fun theTimeoutStopsMidLoop() {
        dev.after = { if (it.startsWith("scrollNode")) clock += 6000 }
        val out = map(call("scroll", """{"dir":"down","amount":1,"until":"排序","maxSteps":20,"timeoutMs":10000}"""))
        assertEquals(false, out["found"])
        assertEquals(2, out["scrolls"])
        assertEquals("time", out["stopped"])
    }

    @Test fun withoutUntilTheOpKeepsItsOriginalShape() {
        val out = map(call("scroll", """{"dir":"down","amount":1}"""))
        assertEquals("a11y", out["method"])
        assertEquals(1, out["steps"])
        assertFalse(out.containsKey("found"))
        assertFalse(out.containsKey("scrolls"))
    }

    @Test fun aDisappearingWindowStopsInsteadOfSpinning() {
        dev.after = { if (it.startsWith("scrollNode")) dev.roots.remove("1") }
        val out = map(call("scroll", """{"dir":"down","amount":1,"until":"排序","maxSteps":20,"timeoutMs":60000}"""))
        assertEquals(false, out["found"])
        assertEquals("no-window", out["stopped"])
    }
}
