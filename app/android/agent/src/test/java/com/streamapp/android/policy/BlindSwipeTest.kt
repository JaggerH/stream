package com.streamapp.android.policy

import com.streamapp.android.agent.AXIS_HORIZONTAL
import com.streamapp.android.agent.AXIS_VERTICAL
import com.streamapp.android.agent.AgentError
import com.streamapp.android.agent.Dispatcher
import com.streamapp.android.agent.FAST_SETTLE
import com.streamapp.android.agent.FakeDevice
import com.streamapp.android.agent.FakeNode
import com.streamapp.android.agent.FakeOcr
import com.streamapp.android.agent.OcrText
import com.streamapp.android.agent.Rect
import com.streamapp.android.agent.UiNode
import com.streamapp.android.agent.WindowInfo
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A free swipe's start point is judged the way a coordinate tap is: a point neither the
 * accessibility tree nor OCR names, in an app where money or goods change hands, is where a drawn
 * slide-to-pay lives and asks for approval. A swipe that pages the scrollable container under it
 * (a list, a gallery) is a scroll, not a commit, and runs free.
 */
class BlindSwipeTest {
    private lateinit var dev: FakeDevice
    private lateinit var policy: PolicyContext
    private lateinit var d: Dispatcher
    private lateinit var ocr: FakeOcr

    private fun call(op: String, args: String = "{}") = d.dispatch(op, JSONObject(args))
    private fun err(op: String, args: String = "{}"): AgentError {
        try {
            call(op, args)
        } catch (e: AgentError) {
            return e
        }
        throw AssertionError("expected AgentError from $op $args")
    }
    private fun reasons(e: AgentError): List<String> {
        val a = e.semantics!!.getJSONArray("reasons")
        return (0 until a.length()).map { a.getString(it) }
    }

    private fun single(vararg kids: UiNode) = FakeNode(
        "FrameLayout", className = "android.widget.FrameLayout", rect = Rect(0, 0, 1080, 2400), children = kids.toList(),
    )

    private fun start(root: UiNode, pkg: String = "com.taobao.taobao", title: String = "淘宝", ocrLines: List<OcrText> = emptyList()) {
        dev = FakeDevice()
        dev.wins = mutableListOf(WindowInfo("1", pkg, title, true))
        dev.roots["1"] = root
        dev.fg = pkg
        policy = PolicyContext.fromSourceTree("blind-swipe-device")
        ocr = FakeOcr(ocrLines)
        d = Dispatcher(dev, policy, settleTiming = FAST_SETTLE, ocrEngine = { ocr })
        call("scopeWindow", """{"match":{"process":"$pkg"}}""")
    }

    /** A nameless picture wall: no node under the point carries a label. */
    private fun drawnPage() = single(
        FakeNode("View", className = "android.view.View", rect = Rect(0, 0, 1080, 2400)),
    )

    /** A vertical product list: scrolling it pages the list, not a commit. */
    private fun productList() = single(
        FakeNode(
            "RecyclerView", "", className = "androidx.recyclerview.widget.RecyclerView",
            rect = Rect(0, 0, 1080, 2400), isScrollable = true, scrollAxis = AXIS_VERTICAL,
            children = listOf(FakeNode("ImageView", "", className = "android.widget.ImageView", rect = Rect(0, 300, 1080, 900))),
        ),
    )

    /** A horizontal gallery: swiping it flips the pictures, not a commit. */
    private fun gallery() = single(
        FakeNode(
            "ViewPager2", "", className = "androidx.viewpager2.widget.ViewPager2",
            rect = Rect(0, 400, 1080, 800), isScrollable = true, scrollAxis = AXIS_HORIZONTAL,
            children = listOf(FakeNode("ImageView", "", className = "android.widget.ImageView", rect = Rect(0, 400, 1080, 800))),
        ),
    )

    // ---- the blind judgment --------------------------------------------------------------

    @Test fun aBlindSwipeInAShoppingAppAsks() {
        start(drawnPage())
        val e = err("swipe", """{"from":{"x":500,"y":1500},"to":{"x":900,"y":1500},"durationMs":300}""")
        assertEquals("approval-required", e.errorCode)
        assertTrue(reasons(e).contains("commit-unrecognized"))
        assertFalse(dev.log.any { it.startsWith("swipe") })
    }

    @Test fun aBlindSwipeOnAPaymentsPageAsks() {
        start(drawnPage(), pkg = "com.unionpay.mobilepay", title = "云闪付")
        val e = err("swipe", """{"from":{"x":500,"y":1400},"to":{"x":500,"y":2000},"durationMs":300}""")
        assertEquals("approval-required", e.errorCode)
        assertTrue(reasons(e).contains("commit-unrecognized"))
        assertFalse(dev.log.any { it.startsWith("swipe") })
    }

    @Test fun aBlindSwipeOutsideThoseCategoriesRunsFree() {
        // Same nameless page, but a category where a swipe is not assumed to move money.
        start(drawnPage(), pkg = "com.tencent.mm", title = "微信")
        call("swipe", """{"from":{"x":500,"y":1500},"to":{"x":900,"y":1500},"durationMs":300}""")
        assertTrue(dev.log.any { it.startsWith("swipe") })
    }

    @Test fun ocrTextUnderTheStartPointNamesIt() {
        // The label lives only in pixels: the text tier reads it, so the point is not blind.
        start(drawnPage(), pkg = "com.unionpay.mobilepay", title = "云闪付",
            ocrLines = listOf(OcrText("轮播图 1/6", Rect(300, 1300, 500, 200), 0.9)))
        call("swipe", """{"from":{"x":500,"y":1400},"to":{"x":900,"y":1400},"durationMs":300}""")
        assertTrue(dev.log.any { it.startsWith("swipe") })
    }

    // ---- paging is not a commit ----------------------------------------------------------

    @Test fun aVerticalSwipeInsideAVerticalListRunsFree() {
        start(productList())
        call("swipe", """{"from":{"x":500,"y":800},"to":{"x":500,"y":300},"durationMs":300}""")
        assertTrue(dev.log.any { it.startsWith("swipe") })
    }

    @Test fun aHorizontalSwipeInsideAGalleryRunsFree() {
        start(gallery())
        call("swipe", """{"from":{"x":900,"y":600},"to":{"x":200,"y":600},"durationMs":300}""")
        assertTrue(dev.log.any { it.startsWith("swipe") })
    }

    @Test fun aSwipeInsideAContainerThatDidNotSayItsAxisRunsFree() {
        // The container offers scroll actions but the tree does not say which way it scrolls: a
        // nameless point inside it is still taken as a page, not a commit.
        start(
            single(
                FakeNode(
                    "ScrollView", "", className = "android.widget.ScrollView",
                    rect = Rect(0, 0, 1080, 2400), isScrollable = true,
                    children = listOf(FakeNode("View", className = "android.view.View", rect = Rect(0, 500, 1080, 900))),
                ),
            ),
        )
        call("swipe", """{"from":{"x":500,"y":900},"to":{"x":500,"y":400},"durationMs":300}""")
        assertTrue(dev.log.any { it.startsWith("swipe") })
    }

    @Test fun aCrosswiseSwipeInsideAListStillAsks() {
        // A horizontal stroke over a vertical list is not that list's paging: the point is still
        // unnamed, so in a shopping app it asks.
        start(productList())
        val e = err("swipe", """{"from":{"x":500,"y":800},"to":{"x":100,"y":800},"durationMs":300}""")
        assertEquals("approval-required", e.errorCode)
        assertTrue(reasons(e).contains("commit-unrecognized"))
        assertFalse(dev.log.any { it.startsWith("swipe") })
    }

    @Test fun aSwipeStartingOnANamedControlRunsFree() {
        start(single(FakeNode("Button", "商品详情", className = "android.widget.Button", rect = Rect(0, 1400, 1080, 200), isClickable = true)))
        call("swipe", """{"from":{"x":500,"y":1500},"to":{"x":500,"y":900},"durationMs":300}""")
        assertTrue(dev.log.any { it.startsWith("swipe") })
    }

    // ---- the slider judgments stay -------------------------------------------------------

    @Test fun aSettingsSliderStillAsksAsSetting() {
        start(
            single(
                FakeNode("SeekBar", "Font size", className = "android.widget.SeekBar",
                    rect = Rect(0, 1000, 1080, 90), isScrollable = true, scrollAxis = AXIS_HORIZONTAL),
            ),
            pkg = "com.android.settings", title = "设置",
        )
        val e = err("swipe", """{"from":{"x":300,"y":1040},"to":{"x":800,"y":1040},"durationMs":300}""")
        assertEquals("approval-required", e.errorCode)
        assertTrue(reasons(e).contains("setting"))
        assertFalse(dev.log.any { it.startsWith("swipe") })
    }

    @Test fun aCommitLabeledSliderStillAsks() {
        start(
            single(FakeNode("SeekBar", "Slide to pay", className = "android.widget.SeekBar", rect = Rect(0, 1000, 1080, 90))),
            pkg = "com.unionpay.mobilepay", title = "云闪付",
        )
        val e = err("swipe", """{"from":{"x":500,"y":1040},"to":{"x":1000,"y":1040},"durationMs":300}""")
        assertEquals("approval-required", e.errorCode)
        assertTrue(reasons(e).containsAll(listOf("commit-label", "payment-label")))
        assertFalse(dev.log.any { it.startsWith("swipe") })
    }
}
