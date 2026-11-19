package com.streamapp.android.agent

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/** The observation fields, ref stability, relocation and the post-action settle wait (see the
 *  openspec change). Runs the dispatcher with a fast settle so tests stay quick. */
class ObservationFieldsTest {
    private lateinit var dev: FakeDevice
    private lateinit var d: Dispatcher
    private val search = FakeNode("Button", "搜索", rect = Rect(100, 200, 50, 40))
    private val input = FakeNode(
        "EditText", "搜索商家或商品", text = "",
        rect = Rect(0, 0, 900, 80), isEditable = true, viewId = "com.app:id/search",
        hintText = "搜索商家或商品", isShowingHint = true,
    )

    private fun call(op: String, args: String = "{}") = d.dispatch(op, JSONObject(args))
    @Suppress("UNCHECKED_CAST") private fun map(v: Any?) = v as Map<String, Any?>
    @Suppress("UNCHECKED_CAST") private fun els(v: Any?) = (v as Map<String, Any?>)["elements"] as List<Map<String, Any?>>

    @Before fun setUp() {
        dev = FakeDevice()
        dev.roots["1"] = FakeNode(
            "FrameLayout", children = listOf(input, search, FakeNode("TextView", "x", viewId = "com.app:id/a1b2")),
            rect = Rect(0, 0, 1080, 2400),
        )
        d = Dispatcher(dev, settleTiming = FAST_SETTLE)
    }

    private fun firstRef(query: String): String = els(call("find", """{"query":$query}"""))[0]["ref"] as String

    // ---- find fields ------------------------------------------------------------------

    @Test fun findCarriesHintViewIdEditableAndViewport() {
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
        val out = map(call("find", """{"query":{"role":"EditText"}}"""))
        assertEquals(mapOf("width" to 1080, "height" to 2400), out["viewport"])
        val el = els(out)[0]
        assertEquals("搜索商家或商品", el["hintText"])
        assertEquals(true, el["isShowingHintText"])
        assertEquals("com.app:id/search", el["viewId"])
        assertEquals(true, el["editable"])
    }

    @Test fun plainNodesCarryEditableAndSkipTheObfuscatedId() {
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
        val el = els(call("find", """{"query":{"role":"TextView"}}"""))[0]
        assertFalse(el.containsKey("viewId"))
        assertEquals(false, el["editable"])
        assertFalse(el.containsKey("hintText"))
        assertFalse(el.containsKey("isShowingHintText"))
    }

    @Test fun uiTreeIsDeclaredAtV6() {
        // v6 adds range stepCount / valueText and the collapsing-toolbar step rule.
        assertEquals(6, ANDROID_CAPS.first { it.id == "ui.tree" }.v)
    }

    // ---- windows fields -----------------------------------------------------------------

    @Test fun windowsCarriesTypeLayerAndViewport() {
        dev.wins = mutableListOf(
            WindowInfo("1", "com.sankuai.meituan", "美团", true),
            WindowInfo("2", "com.baidu.input", "键盘", false, type = "input", layer = 5),
            WindowInfo("3", "overlay.pkg", "悬浮", false, type = "accessibility_overlay", layer = 10),
        )
        val rows = call("windows") as List<Map<String, Any?>>
        assertEquals(mapOf("width" to 1080, "height" to 2400), rows[0]["viewport"])
        assertEquals("application", rows[0]["type"])
        assertEquals("input", rows[1]["type"])
        assertEquals(5, rows[1]["layer"])
        assertEquals("accessibility_overlay", rows[2]["type"])
        assertFalse(rows.filter { it["type"] != "application" }.any { it["foreground"] == true })
    }

    @Test fun overlaysAndKeyboardsAreNotScopeTargets() {
        dev.wins = mutableListOf(
            WindowInfo("1", "com.sankuai.meituan", "美团", true),
            WindowInfo("3", "overlay.pkg", "悬浮", false, type = "accessibility_overlay", layer = 10),
        )
        assertTrue(assertThrows(AgentError::class.java) { call("scopeWindow", """{"match":{"process":"overlay.pkg"}}""") }
            .message!!.startsWith("no-window-match:"))
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
    }

    // ---- ref stability --------------------------------------------------------------------

    @Test fun readingTheSamePageTwiceKeepsTheRefs() {
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
        val a = firstRef("""{"role":"Button"}""")
        val b = firstRef("""{"role":"Button"}""")
        assertEquals(a, b)
    }

    @Test fun aRefSurvivesLaterFindsOfOtherElements() {
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
        val button = firstRef("""{"role":"Button"}""")
        firstRef("""{"role":"EditText"}""")
        map(call("invoke", """{"ref":"$button"}"""))
        assertTrue("click 搜索" in dev.log)
    }

    @Test fun aValueChangedInputKeepsItsRef() {
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
        val ref = firstRef("""{"role":"EditText"}""")
        map(call("setValue", """{"ref":"$ref","text":"肯德基"}"""))
        map(call("setValue", """{"ref":"$ref","text":"麦当劳"}"""))
        assertTrue("setText 搜索商家或商品=麦当劳" in dev.log)
    }

    // ---- stale kinds --------------------------------------------------------------------

    private fun staleKind(op: String, args: String): String =
        try { call(op, args); fail("expected stale-ref"); "" } catch (e: StaleRefException) { e.kind }

    @Test fun garbageAndUnknownRefsAreSnapshotUnknown() {
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
        assertEquals("snapshot_unknown", staleKind("invoke", """{"ref":"zzz"}"""))
        assertEquals("snapshot_unknown", staleKind("invoke", """{"ref":"r99999"}"""))
        assertFalse(dev.log.any { it.startsWith("click") })
    }

    @Test fun aScopeOrWindowChangeRetiresTheRef() {
        dev.wins = mutableListOf(WindowInfo("1", "com.sankuai.meituan", "美团", true), WindowInfo("2", "me.ele", "饿了么", false))
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
        val ref = firstRef("""{"role":"EditText"}""")
        call("scopeWindow", """{"match":{"process":"me.ele"}}""")
        assertEquals("ref_retired", staleKind("setValue", """{"ref":"$ref","text":"x"}"""))
    }

    @Test fun aScrollOverTheRefMovesIt() {
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
        val ref = firstRef("""{"role":"Button"}""")
        dev.scrolled("1", Rect(0, 0, 1080, 2400))
        assertEquals("element_moved", staleKind("invoke", """{"ref":"$ref"}"""))
        assertFalse(dev.log.any { it.startsWith("click") })
    }

    // ---- relocation -----------------------------------------------------------------------

    private fun relocateTree(label: String): FakeNode = FakeNode(
        "FrameLayout",
        children = listOf(
            FakeNode("TextView", "标题", rect = Rect(0, 0, 1080, 100)),
            FakeNode("TextView", "广告", rect = Rect(0, 100, 1080, 100)),
            FakeNode("Button", label, viewId = "com.app:id/skip", rect = Rect(100, 200, 50, 40)),
        ),
        rect = Rect(0, 0, 1080, 2400),
    )

    @Test fun aCountdownRenameRelocatesTheClick() {
        val oldTree = relocateTree("跳过 5")
        dev.roots["1"] = oldTree
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
        val ref = firstRef("""{"role":"Button"}""")
        dev.roots["1"] = relocateTree("跳过 3")
        dev.changed += oldTree.children[2] // the view behind the ref now shows something else
        val out = map(call("invoke", """{"ref":"$ref"}"""))
        assertEquals(true, out["relocated"])
        assertTrue("click 跳过 3" in dev.log)
    }

    @Test fun aSemanticRenameDoesNotRelocate() {
        val oldTree = relocateTree("关注")
        dev.roots["1"] = oldTree
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
        val ref = firstRef("""{"role":"Button"}""")
        dev.roots["1"] = relocateTree("已关注")
        dev.changed += oldTree.children[2]
        assertEquals("element_moved", staleKind("invoke", """{"ref":"$ref"}"""))
        assertFalse(dev.log.any { it.startsWith("click") })
    }

    @Test fun aRotatingHintKeepsTheInputWritable() {
        val old = input.copy(hintText = "搜索商家", name = "搜索商家")
        dev.roots["1"] = FakeNode(
            "FrameLayout",
            children = listOf(old, search, FakeNode("TextView", "标题", rect = Rect(0, 0, 1080, 100))),
            rect = Rect(0, 0, 1080, 2400),
        )
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
        val ref = firstRef("""{"role":"EditText"}""")
        val fresh = input.copy(hintText = "附近的商家", name = "附近的商家")
        dev.roots["1"] = FakeNode(
            "FrameLayout",
            children = listOf(fresh, search, FakeNode("TextView", "标题", rect = Rect(0, 0, 1080, 100))),
            rect = Rect(0, 0, 1080, 2400),
        )
        dev.changed += old
        val out = map(call("setValue", """{"ref":"$ref","text":"肯德基"}"""))
        assertEquals(true, out["relocated"])
        assertTrue("setText 附近的商家=肯德基" in dev.log)
    }

    @Test fun aWindowChangeWithTheSameTreeStillClicksRelocated() {
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
        val ref = firstRef("""{"role":"Button"}""")
        dev.windowChanged()
        val out = map(call("invoke", """{"ref":"$ref"}"""))
        assertEquals(true, out["relocated"])
        assertTrue("click 搜索" in dev.log)
    }

    @Test fun aWindowChangeWithAnotherPageFailsAsElementMoved() {
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
        val ref = firstRef("""{"role":"Button"}""")
        dev.windowChanged()
        dev.roots["1"] = FakeNode("FrameLayout", children = listOf(FakeNode("Button", "别的东西", rect = Rect(5, 5, 30, 20))))
        assertEquals("element_moved", staleKind("invoke", """{"ref":"$ref"}"""))
        assertFalse(dev.log.any { it.startsWith("click") })
    }

    // ---- settle -----------------------------------------------------------------------------

    @Test fun aNoEffectClickReportsNoEffect() {
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
        val out = map(call("click", """{"rect":{"x":100,"y":200,"w":50,"h":40}}"""))
        assertEquals(false, out["settled"])
        assertEquals(false, out["changedDuringRead"])
        assertEquals("no_effect", out["effect"])
        assertEquals("coords", out["via"])
    }

    @Test fun aPageChangeSettlesAsDone() {
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
        dev.after = { op ->
            if (op.startsWith("tap")) {
                dev.roots["1"] = relocateTree("跳过 9")
                dev.lastEventAt = System.currentTimeMillis()
            }
        }
        val out = map(call("click", """{"rect":{"x":100,"y":200,"w":50,"h":40}}"""))
        assertEquals(true, out["settled"])
        assertEquals(true, out["changedDuringRead"])
        assertEquals("done", out["effect"])
    }

    @Test fun aCountdownTickClassifiesAsSmallChange() {
        dev.roots["1"] = FakeNode(
            "FrameLayout",
            children = listOf(input, FakeNode("Button", "跳过 5", viewId = "com.app:id/skip", rect = Rect(100, 200, 50, 40))),
            rect = Rect(0, 0, 1080, 2400),
        )
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
        dev.after = { op ->
            if (op.startsWith("tap")) {
                dev.roots["1"] = FakeNode(
                    "FrameLayout",
                    children = listOf(input, FakeNode("Button", "跳过 3", viewId = "com.app:id/skip", rect = Rect(100, 200, 50, 40))),
                    rect = Rect(0, 0, 1080, 2400),
                )
                dev.lastEventAt = System.currentTimeMillis()
            }
        }
        val out = map(call("click", """{"rect":{"x":100,"y":200,"w":50,"h":40}}"""))
        assertEquals("small_change", out["effect"])
        assertEquals(true, out["changedDuringRead"])
    }

    @Test fun expectIsJudgedAfterTheWait() {
        call("scopeWindow", """{"match":{"process":"com.sankuai.meituan"}}""")
        dev.after = { op ->
            if (op.startsWith("tap")) {
                dev.roots["1"] = relocateTree("跳过 9")
                dev.lastEventAt = System.currentTimeMillis()
            }
        }
        val out = map(call("click", """{"rect":{"x":100,"y":200,"w":50,"h":40},"expect":{"role":"Button"}}"""))
        assertEquals(true, out["confirmed"])
        assertEquals(true, out["settled"])
    }

    @Test fun pressAlsoSettles() {
        val out = map(call("press", """{"key":"Home"}"""))
        assertEquals("coords", out["via"])
        assertEquals(false, out["settled"])
        assertTrue(dev.log.contains("home"))
    }
}
