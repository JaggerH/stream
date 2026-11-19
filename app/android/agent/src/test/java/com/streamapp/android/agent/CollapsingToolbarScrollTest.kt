package com.streamapp.android.agent

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * A collapsing-toolbar page (AppBarLayout + CollapsingToolbarLayout above a RecyclerView): the
 * first scroll collapses the app bar, which moves the whole list up without scrolling its own
 * content. That layout shift is not a list move: the scroll must go on to scroll the list itself,
 * and the receipt must count only the list's own moves.
 */
class CollapsingToolbarScrollTest {
    private lateinit var dev: FakeDevice
    private lateinit var d: Dispatcher
    private var clock = 0L
    private var collapsed = false
    private var offset = 0

    private companion object {
        const val READ_COST = 200L
        const val SCROLL_COST = 100L
        const val BAR_EXPANDED = 480
        const val BAR_COLLAPSED = 120
        const val ROW_H = 200
    }

    private fun call(op: String, args: String = "{}") = d.dispatch(op, JSONObject(args))
    @Suppress("UNCHECKED_CAST") private fun map(v: Any?) = v as Map<String, Any?>

    /** The page as it looks now; [wrap] puts the app bar and the list inside a NestedScrollView
     *  (the collapsing-toolbar shape), otherwise they are siblings (the CoordinatorLayout shape). */
    private fun screen(wrap: Boolean = true): FakeNode {
        val bar = if (collapsed) BAR_COLLAPSED else BAR_EXPANDED
        val rows = (0 until 10).map { i ->
            FakeNode(
                "TextView", "设置项 ${i + offset}", className = "android.widget.TextView",
                rect = Rect(0, bar + i * ROW_H - offset * ROW_H, 1080, ROW_H),
            )
        }
        val appBar = FakeNode(
            "AppBarLayout", "app_bar", className = "com.google.android.material.appbar.AppBarLayout",
            rect = Rect(0, 0, 1080, bar),
            children = listOf(
                FakeNode(
                    "CollapsingToolbarLayout", "collapsing",
                    className = "com.google.android.material.appbar.CollapsingToolbarLayout",
                    rect = Rect(0, 0, 1080, bar),
                    children = listOf(FakeNode("TextView", "设置", className = "android.widget.TextView", rect = Rect(0, 0, 1080, bar))),
                ),
            ),
        )
        val list = FakeNode(
            "RecyclerView", "list", className = "androidx.recyclerview.widget.RecyclerView",
            rect = Rect(0, bar, 1080, 2400 - bar), isScrollable = true, children = rows,
        )
        val body: List<UiNode> = if (wrap) {
            listOf(
                FakeNode(
                    "NestedScrollView", "page", className = "androidx.core.widget.NestedScrollView",
                    rect = Rect(0, 0, 1080, 2400), isScrollable = true, children = listOf(appBar, list),
                ),
            )
        } else {
            listOf(appBar, list)
        }
        return FakeNode("FrameLayout", className = "android.widget.FrameLayout", rect = Rect(0, 0, 1080, 2400), children = body)
    }

    /** Every sleep and action costs time; a scroll on the list first collapses the app bar, then
     *  scrolls the list's own content. */
    private fun chargeDevices() {
        dev.after = { s ->
            when {
                s.startsWith("sleep") -> clock += s.removePrefix("sleep ").trim().toLong()
                s.startsWith("scrollNode list") -> {
                    clock += SCROLL_COST
                    if (!collapsed) collapsed = true else offset++
                    dev.roots["1"] = screen()
                }
                s.startsWith("scrollNode") -> clock += SCROLL_COST
            }
        }
    }

    @Before fun setUp() {
        dev = FakeDevice()
        dev.roots["1"] = screen()
        d = Dispatcher(dev, settleTiming = Settle(), now = { clock })
        chargeDevices()
    }

    @Test fun theAppBarCollapseIsNotAListMove() {
        val out = map(call("scroll", """{"dir":"down","amount":1}"""))
        // The action that only folded the app bar is not a step; the step that counts is the one
        // that scrolled the list, and the list is the container (not the app bar, not the wrapper).
        assertEquals("a11y", out["method"])
        assertEquals(out.toString(), 1, out["steps"])
        assertTrue(out.toString(), dev.log.filter { it.startsWith("scrollNode") }.all { it.startsWith("scrollNode list") })
        assertEquals("the list scrolled", 1, offset)
    }

    @Test fun theReceiptKeepsItsTimingAndBounds() {
        val out = map(call("scroll", """{"dir":"down","amount":2}"""))
        val timing = map(out["timing"])
        assertEquals(setOf("a11yMs", "gestureMs", "settleMs", "changeCheckMs", "steps"), timing.keys)
        assertEquals(2, out["steps"])
        assertEquals(2, offset)
        assertTrue("simulated op took $clock ms", clock <= 10_000)
    }

    @Test fun untilScrollsTheListAfterTheCollapse() {
        val out = map(call("scroll", """{"dir":"down","amount":1,"until":"设置项 5","maxSteps":10,"timeoutMs":60000}"""))
        assertEquals(out.toString(), true, out["found"])
        assertEquals("设置项 5", map(out["match"])["name"])
        assertTrue(out.toString(), dev.log.filter { it.startsWith("scrollNode") }.all { it.startsWith("scrollNode list") })
    }

    @Test fun aCollapseThatNeverEndsStaysBounded() {
        // Every step only shifts the container's layout: the scroll gives up on this candidate
        // and finishes, without looping forever.
        dev.roots["1"] = screen(wrap = false)
        dev.after = { s ->
            when {
                s.startsWith("sleep") -> clock += s.removePrefix("sleep ").trim().toLong()
                s.startsWith("scrollNode list") -> {
                    clock += SCROLL_COST
                    // Only the bar keeps changing; the list's content never scrolls.
                    collapsed = !collapsed
                    dev.roots["1"] = screen(wrap = false)
                }
                s.startsWith("scrollNode") -> clock += SCROLL_COST
            }
        }
        val out = map(call("scroll", """{"dir":"down","amount":3}"""))
        assertEquals("the list never scrolled", 0, offset)
        // The a11y path never counted a list move, so the fallback gesture is what ran.
        assertEquals("gesture", out["method"])
        assertTrue("simulated op took $clock ms", clock <= 12_000)
    }
}
