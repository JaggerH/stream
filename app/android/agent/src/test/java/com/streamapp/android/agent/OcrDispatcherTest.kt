package com.streamapp.android.agent

import com.streamapp.android.policy.PolicyContext
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The text tier end to end: `find` returns OCR lines when the tree cannot see (or when asked),
 * the same frame is recognized once, and a coordinate tap the tree cannot name is judged by the
 * text under it — or, with no text at all, by the app's category.
 */
class OcrDispatcherTest {
    private lateinit var dev: FakeDevice
    private lateinit var d: Dispatcher
    private lateinit var ocr: FakeOcr
    private lateinit var policy: PolicyContext

    @Suppress("UNCHECKED_CAST") private fun map(v: Any?) = v as Map<String, Any?>
    @Suppress("UNCHECKED_CAST") private fun els(v: Any?) = map(v)["elements"] as List<Map<String, Any?>>
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

    /** A canvas-drawn page: thirteen nameless nodes, no height for a name anywhere. */
    private fun canvas() = FakeNode(
        "FrameLayout", className = "android.widget.FrameLayout", rect = Rect(0, 0, 1080, 2400),
        children = (0 until 13).map {
            FakeNode("View", className = "android.view.View", rect = Rect(0, it * 180, 1080, 180))
        },
    )

    /** A readable tree: three named nodes is what stops the automatic OCR. */
    private fun readable() = FakeNode(
        "FrameLayout", className = "android.widget.FrameLayout", rect = Rect(0, 0, 1080, 2400),
        children = listOf(
            FakeNode("Button", "搜索", rect = Rect(0, 0, 300, 90), isClickable = true),
            FakeNode("Button", "购物车", rect = Rect(780, 0, 300, 90), isClickable = true),
            FakeNode("TextView", "商品详情", rect = Rect(0, 200, 1080, 90)),
        ),
    )

    private val addToCart = OcrText("加入购物车", Rect(200, 2000, 400, 120), 0.93)
    private val tapOnAdd = """{"rect":{"x":380,"y":2040,"w":40,"h":40}}"""

    @Before fun setUp() {
        policy = PolicyContext.fromSourceTree("ocr-device")
        ocr = FakeOcr()
    }

    private fun start(root: UiNode, pkg: String = "com.taobao.taobao", title: String = "淘宝") {
        dev = FakeDevice()
        dev.wins = mutableListOf(WindowInfo("1", pkg, title, true))
        dev.roots["1"] = root
        dev.fg = pkg
        d = Dispatcher(dev, policy, settleTiming = FAST_SETTLE, ocrEngine = { ocr })
        call("scopeWindow", """{"match":{"process":"$pkg"}}""")
    }

    // ---- find -------------------------------------------------------------------------

    @Test fun autoNamesAnUnreadablePage() {
        ocr.lines = listOf(addToCart)
        start(canvas())
        val out = map(call("find", """{"query":{"nameContains":"加入购物车"}}"""))
        val elements = els(out)
        assertEquals(1, elements.size)
        assertEquals("ocr-text", elements[0]["role"])
        assertEquals("ocr", elements[0]["className"])
        assertEquals("加入购物车", elements[0]["name"])
        assertEquals("ocr", elements[0]["source"])
        assertEquals(0.93, elements[0]["confidence"])
        assertEquals(mapOf("x" to 200, "y" to 2000, "w" to 400, "h" to 120), elements[0]["rect"])
        val note = map(out["ocr"])
        assertEquals(true, note["ran"])
        assertEquals(false, note["cached"])
        assertEquals(1, note["texts"])
        assertTrue(map(out["timing"])["ocrMs"] is Number)
        assertEquals(1, dev.screenshots)
    }

    @Test fun aReadableTreeDoesNotPayForOcr() {
        ocr.lines = listOf(addToCart)
        start(readable())
        val out = map(call("find", """{"query":{"role":"Button"}}"""))
        assertEquals(2, els(out).size)
        assertFalse(out.containsKey("ocr"))
        assertFalse(out.containsKey("timing"))
        assertEquals(0, dev.screenshots)
        assertEquals(0, ocr.calls)
    }

    @Test fun theCallerCanForceAndForbidIt() {
        ocr.lines = listOf(OcrText("搜索", Rect(0, 0, 300, 90), 0.9))
        start(readable())
        val forced = map(call("find", """{"query":{"nameContains":"搜索"},"ocr":"on"}"""))
        assertTrue(els(forced).any { it["source"] == "ocr" })
        assertEquals(1, dev.screenshots)

        val callsBefore = ocr.calls
        start(canvas())
        val off = map(call("find", """{"query":{"nameContains":"加入购物车"},"ocr":"off"}"""))
        assertFalse(off.containsKey("ocr"))
        assertEquals(0, dev.screenshots)
        assertEquals(callsBefore, ocr.calls)
    }

    @Test fun aBadModeIsRejected() {
        start(canvas())
        assertTrue(err("find", """{"query":{"role":"Button"},"ocr":"maybe"}""").message!!.startsWith("unsupported-ocr:"))
    }

    @Test fun theSameFrameIsRecognizedOnce() {
        ocr.lines = listOf(addToCart)
        start(canvas())
        call("find", """{"query":{"nameContains":"加入购物车"},"ocr":"on"}""")
        val second = map(call("find", """{"query":{"nameContains":"加入购物车"},"ocr":"on"}"""))
        assertEquals(true, map(second["ocr"])["cached"])
        assertEquals(0L, map(second["timing"])["ocrMs"])
        assertEquals(1, ocr.calls)
    }

    @Test fun aFailureLeavesTheAccessibleReadIntact() {
        ocr.failure = IllegalStateException("no model")
        start(canvas())
        val out = map(call("find", """{"query":{"role":"View"}}"""))
        assertTrue(map(out["ocr"])["error"].toString().startsWith("ocr-failed:"))
        assertEquals(13, els(out).size)
    }

    @Test fun theCapabilityIsDeclared() {
        val cap = ANDROID_CAPS.first { it.id == "ui.ocr" }
        assertEquals(1, cap.v)
    }

    // ---- the gate ---------------------------------------------------------------------

    @Test fun aHarmlessOcrLabelRuns() {
        ocr.lines = listOf(addToCart)
        start(canvas())
        val out = map(call("click", tapOnAdd))
        assertTrue(dev.log.toString(), "tap 400,2060 long=false" in dev.log)
        assertEquals(true, map(out["ocr"])["ran"])
        assertTrue(map(out["timing"])["ocrMs"] is Number)
    }

    @Test fun aSelfDrawnCommitAsks() {
        for ((label, money) in listOf(
            "提交订单" to false,
            "立即支付" to true,
            "立即购买" to true,
            "领券购买" to true,
        )) {
            ocr.lines = listOf(OcrText(label, Rect(200, 2000, 400, 120), 0.9))
            start(canvas())
            val e = err("click", tapOnAdd)
            assertEquals(label, "approval-required", e.errorCode)
            assertTrue(label, reasons(e).contains("commit-label"))
            assertEquals(label, money, reasons(e).contains("payment-label"))
            assertEquals(label, "ocr-text", e.semantics!!.getJSONObject("control").getString("role"))
            assertEquals(label, label, e.semantics!!.getJSONObject("control").getString("label"))
            assertFalse(label, dev.log.any { it.startsWith("tap") })
        }
    }

    @Test fun aBlindClickInAShoppingAppAsks() {
        ocr.lines = emptyList()
        start(canvas())
        val e = err("click", tapOnAdd)
        assertEquals("approval-required", e.errorCode)
        assertTrue(reasons(e).contains("commit-unrecognized"))
        assertFalse(dev.log.any { it.startsWith("tap") })
    }

    @Test fun aBlindClickElsewhereStaysAllowed() {
        ocr.lines = emptyList()
        start(canvas(), pkg = "com.example.app", title = "Some App")
        call("click", tapOnAdd)
        assertTrue(dev.log.toString(), "tap 400,2060 long=false" in dev.log)
    }

    @Test fun anEngineThatCannotRunStillAsksInAShoppingApp() {
        ocr.failure = IllegalStateException("no model")
        start(canvas())
        val e = err("click", tapOnAdd)
        assertEquals("approval-required", e.errorCode)
        assertTrue(reasons(e).contains("commit-unrecognized"))
        assertFalse(dev.log.any { it.startsWith("tap") })
    }

    @Test fun aNamedNodeKeepsPrecedenceOverOcr() {
        ocr.lines = listOf(OcrText("立即支付", Rect(200, 2000, 800, 120), 0.9))
        start(FakeNode(
            "FrameLayout", className = "android.widget.FrameLayout", rect = Rect(0, 0, 1080, 2400),
            children = listOf(
                FakeNode("View", className = "android.view.View", rect = Rect(0, 0, 1080, 2400)),
                FakeNode("Button", "商品详情", rect = Rect(200, 2000, 800, 120), isClickable = true),
            ),
        ))
        call("click", tapOnAdd)
        assertTrue(dev.log.toString(), "tap 400,2060 long=false" in dev.log)
    }

    @Test fun invokingAnOcrRefTapsItsCentre() {
        ocr.lines = listOf(addToCart)
        start(canvas())
        val ref = els(call("find", """{"query":{"nameContains":"加入购物车"}}"""))[0]["ref"]
        call("invoke", """{"ref":"$ref"}""")
        assertTrue(dev.log.toString(), "tap 400,2060 long=false" in dev.log)
    }

    @Test fun anOcrRefGoesStaleWhenTheScreenChanges() {
        ocr.lines = listOf(addToCart)
        start(canvas())
        val ref = els(call("find", """{"query":{"nameContains":"加入购物车"}}"""))[0]["ref"] as String
        dev.windowChanged()
        val e = err("invoke", """{"ref":"$ref"}""")
        assertEquals("stale-ref", e.errorCode)
        assertEquals("element_moved", e.semantics!!.getString("kind"))
    }
}
