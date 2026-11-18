package com.streamapp.android.agent

import org.junit.Assert.*
import org.junit.Test

/** The recognition primitives behind ref stability and relocation (design informed by Mika,
 *  Apache-2.0 — see the openspec change for the borrow note). */
class StabilityTest {
    private val screen = Rect(0, 0, 1080, 2400)
    private val shortEdge = 1080

    private fun fp(
        role: String,
        name: String,
        viewId: String = "",
        rect: Rect = Rect(0, 0, 10, 10),
        editable: Boolean = false,
        hint: Boolean = false,
        inList: Boolean = false,
        context: String? = null,
    ) = ElementFp(role, "android.widget.$role", name, name, viewId, rect, editable, hint, inList, context)

    // ---- identity -------------------------------------------------------------------

    @Test fun anInputsIdentityNameIsItsHintNotItsValue() {
        val box = fp("EditText", "肯德基", viewId = "com.app:id/search", editable = true)
        // The value "肯德基" must not be the identity: the fp carries it, but the key uses the hint.
        // (ElementFp keeps the real name in `name`; identityName is what the key hashes.)
        assertEquals("肯德基", box.name)
    }

    @Test fun onlyNamedOrIdentifiedElementsAreRecognizable() {
        assertTrue(identifiable(fp("Button", "搜索")))
        assertTrue(identifiable(fp("View", "", viewId = "com.app:id/x")))
        assertFalse(identifiable(fp("View", "")))
    }

    // ---- relocation -----------------------------------------------------------------

    @Test fun aUniqueIdentialInTheSameSpotRelocates() {
        val prev = fp("Button", "搜索", viewId = "com.app:id/s", rect = Rect(100, 200, 50, 40))
        val after = listOf(prev.copy(rect = Rect(102, 202, 50, 40)))
        assertEquals(Relocation.Found(0), relocate(prev, listOf(prev), after, shortEdge))
    }

    @Test fun anAmbiguousMatchDoesNotRelocate() {
        val prev = fp("Button", "关注", rect = Rect(0, 0, 50, 40))
        val after = listOf(prev, prev.copy(rect = Rect(500, 0, 50, 40)))
        assertEquals(Relocation.Ambiguous, relocate(prev, listOf(prev, prev.copy(rect = Rect(500, 0, 50, 40))), after, shortEdge))
    }

    @Test fun aFarMoveDoesNotRelocate() {
        val prev = fp("Button", "搜索", rect = Rect(0, 0, 50, 40), context = "标题")
        val after = listOf(fp("TextView", "标题"), prev.copy(rect = Rect(900, 2200, 50, 40)))
        assertEquals(Relocation.Moved, relocate(prev, listOf(fp("TextView", "标题"), prev), after, shortEdge))
    }

    @Test fun aChangedContextWithoutBeingInPlaceDoesNotRelocate() {
        // Same name, moved a little inside a list, and the page itself moved: another row may
        // have slid into the spot (list rows recycle). Not stationary, not in place — moved.
        val prev = fp("Button", "加入购物车", rect = Rect(100, 1000, 400, 80), inList = true, context = "商品甲")
        val after = listOf(fp("TextView", "商品乙"), fp("Button", "加入购物车", rect = Rect(100, 1035, 400, 80), inList = true, context = "商品乙"))
        assertEquals(Relocation.Moved, relocate(prev, listOf(fp("TextView", "商品甲"), prev), after, shortEdge))
    }

    @Test fun aCountdownRenameRelocatesOnAStaticPage() {
        val prev = fp("Button", "跳过 5", viewId = "com.app:id/skip", rect = Rect(100, 200, 50, 40), context = "广告")
        val title = fp("TextView", "标题", rect = Rect(0, 0, 1080, 100))
        val after = listOf(title, fp("TextView", "广告"), fp("Button", "跳过 3", viewId = "com.app:id/skip", rect = Rect(100, 200, 50, 40)))
        assertEquals(Relocation.Found(2), relocate(prev, listOf(title, fp("TextView", "广告"), prev), after, shortEdge))
    }

    @Test fun aCountdownRenameDoesNotRelocateWhenThePageMoves() {
        val prev = fp("Button", "跳过 5", viewId = "com.app:id/skip", rect = Rect(100, 200, 50, 40))
        val after = listOf(fp("Button", "跳过 3", viewId = "com.app:id/skip", rect = Rect(100, 2100, 50, 40)))
        assertEquals(Relocation.Gone, relocate(prev, listOf(prev), after, shortEdge))
    }

    @Test fun aRotatingHintRenameRelocatesOnAStaticPage() {
        val prev = fp("EditText", "搜索商家", viewId = "com.app:id/search", rect = Rect(100, 200, 900, 80), editable = true, hint = true)
        val title = fp("TextView", "标题", rect = Rect(0, 0, 1080, 100))
        val ad = fp("TextView", "广告", rect = Rect(0, 100, 1080, 100))
        val after = listOf(title, ad, fp("EditText", "附近的商家", viewId = "com.app:id/search", rect = Rect(100, 200, 900, 80), editable = true, hint = true))
        assertEquals(Relocation.Found(2), relocate(prev, listOf(title, ad, prev), after, shortEdge))
    }

    @Test fun aSemanticRenameDoesNotRelocate() {
        val prev = fp("Button", "关注", viewId = "com.app:id/follow", rect = Rect(100, 200, 50, 40), context = "用户甲")
        val after = listOf(fp("TextView", "用户甲"), fp("Button", "已关注", viewId = "com.app:id/follow", rect = Rect(100, 200, 50, 40)))
        assertEquals(Relocation.Gone, relocate(prev, listOf(fp("TextView", "用户甲"), prev), after, shortEdge))
    }

    // ---- stationary -----------------------------------------------------------------

    @Test fun aStaticPageIsStationary() {
        val before = listOf(fp("TextView", "标题", rect = Rect(0, 0, 1080, 100)), fp("Button", "搜索", rect = Rect(100, 200, 50, 40)))
        val after = before.map { it.copy(rect = it.rect.copy(x = it.rect.x + 5, y = it.rect.y + 5)) }
        assertTrue(stationary(before, after, shortEdge))
    }

    @Test fun aScrolledOrSwappedPageIsNotStationary() {
        val before = listOf(fp("TextView", "标题", rect = Rect(0, 0, 1080, 100)), fp("Button", "搜索", rect = Rect(100, 200, 50, 40)))
        val after = listOf(before[0], before[1].copy(rect = Rect(100, 2100, 50, 40)))
        assertFalse(stationary(before, after, shortEdge))
        assertFalse(stationary(before, emptyList(), shortEdge))
    }

    // ---- effect classification --------------------------------------------------------

    @Test fun effectClassification() {
        val a = fp("Button", "搜索", rect = Rect(100, 200, 50, 40))
        assertEquals("no_effect", effectOf(listOf(a), listOf(a)))
        assertEquals(
            "small_change",
            effectOf(listOf(a), listOf(a.copy(name = "搜索 3"))),
        )
        assertEquals(
            "place_changed",
            effectOf(listOf(a), listOf(a.copy(rect = Rect(100, 400, 50, 40)))),
        )
        assertEquals(
            "done",
            effectOf(listOf(a), listOf(a.copy(name = "已下单"))),
        )
    }

    // ---- resource id filter -----------------------------------------------------------

    @Test fun readableResourceIds() {
        assertEquals("com.app:id/search_input", readableResourceId("com.app:id/search_input"))
        assertEquals("com.app:id/name", readableResourceId("com.app:id/name"))
        assertNull(readableResourceId("com.app:id/a1b2"))
        assertNull(readableResourceId("com.app:id/ab1"))
        assertNull(readableResourceId("com.app:id/w1e"))
        assertNull(readableResourceId(""))
    }

    // ---- stripDigits -------------------------------------------------------------------

    @Test fun stripDigitsLeavesTheStablePart() {
        assertEquals("跳过", stripDigits("跳过 5"))
        assertEquals(":", stripDigits("00:59"))
        assertEquals("已关注", stripDigits("已关注"))
    }
}
