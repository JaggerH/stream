package com.streamapp.android.agent

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Scrolling a page whose content never goes still (a carousel, a countdown) must not wait for
 * quiescence: a step ends as soon as the scroll container visibly moved, one step is bounded, the
 * whole op is bounded, and the receipt says where the time went.
 *
 * Everything is driven by a fake clock: every tree read charges [READ_COST] ms and every device
 * sleep charges its own duration, so the bounds can be asserted deterministically.
 */
class ScrollLatencyTest {
    private lateinit var dev: FakeDevice
    private lateinit var d: Dispatcher
    private var clock = 0L

    private companion object {
        /** A tree read on a large feed is the expensive unit; 200 ms is deliberately slow. */
        const val READ_COST = 200L
        const val SCROLL_COST = 100L
    }

    private fun call(op: String, args: String = "{}") = d.dispatch(op, JSONObject(args))
    @Suppress("UNCHECKED_CAST") private fun map(v: Any?) = v as Map<String, Any?>
    private fun ms(m: Map<String, Any?>, key: String) = (m[key] as Number).toLong()

    private fun page(vararg kids: UiNode) =
        FakeNode("FrameLayout", className = "android.widget.FrameLayout", rect = Rect(0, 0, 1080, 2400), children = kids.toList())

    private fun list(name: String, y: Int = 0, h: Int = 2000, kids: List<UiNode> = emptyList()) =
        FakeNode(
            "RecyclerView", name, className = "androidx.recyclerview.widget.RecyclerView",
            rect = Rect(0, y, 1080, h), isScrollable = true, children = kids,
        )

    private fun row(name: String, y: Int) =
        FakeNode("TextView", name, className = "android.widget.TextView", rect = Rect(0, y, 1080, 200))

    /** A countdown: same place, new text every read — the page never goes quiet. */
    private fun ticker(text: String, y: Int = 1900) =
        FakeNode("TextView", text, className = "android.widget.TextView", rect = Rect(0, y, 1080, 60))

    private var ticks = 0

    /** Every read costs time and (when [changing]) ticks the countdown and moves the rows as the
     *  fake device reports scroll steps. */
    private fun chargeReads(changing: Boolean = false) {
        dev.onRead = {
            clock += READ_COST
            if (changing) {
                ticks++
                dev.roots["1"] = page(
                    list("list", 0, 2000, listOf(
                        row("商品 ${dev.moved}", 100 + dev.moved * 120),
                        ticker("剩余 $ticks"),
                    )),
                )
            }
        }
    }

    /** Every sleep costs its own duration; every accessibility scroll costs [SCROLL_COST]. */
    private fun chargeDevices(scrollMs: Long = SCROLL_COST) {
        dev.after = { s ->
            when {
                s.startsWith("sleep") -> clock += s.removePrefix("sleep ").trim().toLong()
                s.startsWith("scrollNode") -> clock += scrollMs
            }
        }
    }

    @Before fun setUp() {
        dev = FakeDevice()
        dev.roots["1"] = page(list("list", 0, 2000, listOf(row("商品 A", 100))))
        d = Dispatcher(dev, settleTiming = Settle(), now = { clock })
    }

    // ---- the receipt -------------------------------------------------------------------

    @Test fun theScrollReceiptCarriesThePhaseTimings() {
        chargeReads()
        chargeDevices()
        val out = map(call("scroll", """{"dir":"down","amount":2}"""))
        assertEquals(2, out["steps"])
        val timing = map(out["timing"])
        assertEquals(setOf("a11yMs", "gestureMs", "settleMs", "changeCheckMs", "steps"), timing.keys)
        assertEquals(2, timing["steps"])
        assertTrue("a11yMs=${timing["a11yMs"]}", ms(timing, "a11yMs") >= 2 * SCROLL_COST)
        assertEquals(0, ms(timing, "gestureMs"))
        assertTrue("changeCheckMs=${timing["changeCheckMs"]}", ms(timing, "changeCheckMs") >= READ_COST)
        assertTrue("settleMs=${timing["settleMs"]}", ms(timing, "settleMs") > 0)
        // The old receipt keys keep their meaning.
        assertEquals("a11y", out["method"])
        assertEquals("a11y", out["via"])
        assertFalse(out.containsKey("found"))
    }

    @Test fun aGestureScrollReportsItsPhaseToo() {
        dev.roots["1"] = page(FakeNode("TextView", "没有可滚动容器", rect = Rect(0, 100, 1080, 100)))
        chargeReads()
        chargeDevices()
        val out = map(call("scroll", """{"dir":"down","amount":2}"""))
        val timing = map(out["timing"])
        assertEquals("gesture", out["method"])
        assertEquals(2, out["steps"])
        assertEquals(2, timing["steps"])
        assertEquals(0, ms(timing, "a11yMs"))
    }

    // ---- a page that never settles ------------------------------------------------------

    @Test fun aPageThatKeepsChangingReturnsInsideTheWholeOpBound() {
        // A step that moved is complete as soon as the first visible item changed position; the
        // ticking countdown must not make every step wait for the poll budget to run out.
        chargeReads(changing = true)
        chargeDevices()
        val out = map(call("scroll", """{"dir":"down","amount":10}"""))
        assertEquals(10, out["steps"])
        assertFalse(out.containsKey("stopped"))
        assertTrue("simulated op took $clock ms", clock <= 10_000)
    }

    @Test fun aStepThatNeverMovesWaitsAtMostOneStepCap() {
        dev.scrollMoves = MutableList(20) { false }
        chargeReads(changing = true)
        chargeDevices()
        val out = map(call("scroll", """{"dir":"down","amount":1}"""))
        assertTrue("simulated op took $clock ms", clock <= 2_500)
        assertTrue("steps=${out["steps"]}", (out["steps"] as Int) >= 0)
    }

    @Test fun aStepCompletesWhenTheFirstVisibleItemMoves() {
        // The page is otherwise still: only the rows move with the scroll, and each poll would
        // find them moving if the old wait-for-quiet rule were kept.
        chargeReads(changing = true)
        chargeDevices()
        val before = clock
        call("scroll", """{"dir":"down","amount":1}""")
        assertTrue("a moved step cost ${clock - before} ms", clock - before <= 1_600)
    }

    @Test fun theOpStopsAtTheWholeOpCapWithTheStepsItFinished() {
        chargeReads(changing = true)
        chargeDevices(scrollMs = 2_000)
        val out = map(call("scroll", """{"dir":"down","amount":10}"""))
        assertEquals(out.toString(), "time", out["stopped"])
        // Four steps were verified; the fifth action started before the bound and used it up, so
        // its movement was not checked and it does not count.
        assertEquals(4, out["steps"])
        assertEquals(5, dev.log.count { it.startsWith("scrollNode") })
        assertTrue("simulated op took $clock ms", clock <= 13_000)
    }

    @Test fun theSettleCheckAfterAScrollDoesNotWaitForQuiet() {
        // Every sleep is an accessibility event, so the page is never quiet.
        chargeReads(changing = true)
        dev.after = { s ->
            if (s.startsWith("sleep")) {
                clock += s.removePrefix("sleep ").trim().toLong()
                dev.lastEventAt = clock
            } else if (s.startsWith("scrollNode")) {
                clock += SCROLL_COST
            }
        }
        val out = map(call("scroll", """{"dir":"down","amount":1}"""))
        val timing = map(out["timing"])
        assertEquals(false, out["settled"])
        assertTrue("settleMs=${timing["settleMs"]}", ms(timing, "settleMs") <= 700)
    }

    // ---- the container that moved is remembered ----------------------------------------

    @Test fun untilReusesTheContainerThatMovedFirst() {
        val a = list("list A", 0, 1500, listOf(row("A1", 100)))
        val b = list("list B", 1500, 900, listOf(row("B1", 1600)))
        dev.roots["1"] = page(a, b)
        // After the first scroll, B grows to cover more of the screen than A.
        val bBig = list("list B", 200, 2200, listOf(row("B1", 300)))
        dev.after = { s ->
            when {
                s.startsWith("sleep") -> clock += s.removePrefix("sleep ").trim().toLong()
                s.startsWith("scrollNode") -> {
                    clock += SCROLL_COST
                    dev.roots["1"] = page(a, bBig)
                }
            }
        }
        chargeReads()
        val out = map(call("scroll", """{"dir":"down","amount":1,"until":"不存在","maxSteps":2}"""))
        assertEquals(false, out["found"])
        assertEquals(
            listOf("scrollNode list A forward", "scrollNode list A forward"),
            dev.log.filter { it.startsWith("scrollNode") },
        )
        assertTrue(map(out["timing"]).containsKey("changeCheckMs"))
    }

    @Test fun untilUsesTheTenSecondDefaultTimeBound() {
        chargeReads()
        chargeDevices(scrollMs = 4_000)
        val out = map(call("scroll", """{"dir":"down","amount":1,"until":"不存在","maxSteps":50}"""))
        assertEquals(false, out["found"])
        assertEquals("time", out["stopped"])
        assertTrue("simulated op took $clock ms", clock <= 12_000)
        assertTrue("scrolls=${out["scrolls"]}", (out["scrolls"] as Int) in 1..3)
    }

    @Test fun theUntilReceiptKeepsItsShape() {
        chargeReads()
        chargeDevices()
        val out = map(call("scroll", """{"dir":"down","amount":1,"until":"商品 A"}"""))
        assertEquals(true, out["found"])
        assertEquals(0, out["scrolls"])
        val match = map(out["match"])
        assertEquals("商品 A", match["name"])
        assertEquals(0, map(out["timing"])["steps"])
    }
}
