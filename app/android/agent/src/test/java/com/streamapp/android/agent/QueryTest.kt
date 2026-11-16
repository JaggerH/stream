package com.streamapp.android.agent

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class QueryTest {
    private val tree = n("FrameLayout", "",
        n("LinearLayout", "搜索栏",
            n("EditText", "搜索商家或商品"),
            n("Button", "搜索")),
        n("RecyclerView", "",
            n("ViewGroup", "麦当劳 月售 9999+", n("TextView", "麦当劳"), n("TextView", "月售 9999+")),
            n("ViewGroup", "肯德基 月售 5000+", n("TextView", "肯德基"), n("TextView", "月售 5000+"))),
    )

    private fun q(json: String) = A11yQuery.from(JSONObject(json))

    @Test fun matchesRoleAndExactName() {
        assertEquals(listOf("搜索"), findAll(tree, q("""{"role":"Button","name":"搜索"}""")).map { it.name })
    }

    @Test fun nameIsCaseSensitiveButNameContainsIsNot() {
        val t = n("FrameLayout", "", n("Button", "OK"))
        assertTrue(findAll(t, q("""{"name":"ok"}""")).isEmpty())
        assertEquals(1, findAll(t, q("""{"nameContains":"ok"}""")).size)
    }

    @Test fun nameContainsNeverMatchesAnUnnamedNode() {
        assertTrue(findAll(n("FrameLayout", "", n("ImageView")), q("""{"nameContains":""}""")).isEmpty())
    }

    @Test fun rejectsNameTogetherWithNameContains() {
        assertThrows(IllegalArgumentException::class.java) { q("""{"name":"a","nameContains":"a"}""") }
    }

    @Test fun pathSegmentsMustAppearInOrderAmongAncestors() {
        val hits = findAll(tree, q("""{"role":"TextView","path":[{"role":"RecyclerView"},{"name":"肯德基 月售 5000+"}]}"""))
        assertEquals(listOf("肯德基", "月售 5000+"), hits.map { it.name })
        assertTrue(findAll(tree, q("""{"role":"TextView","path":[{"name":"肯德基 月售 5000+"},{"role":"RecyclerView"}]}""")).isEmpty())
    }

    @Test fun documentOrderAndRootExcluded() {
        assertEquals(listOf("麦当劳", "月售 9999+", "肯德基", "月售 5000+"), findAll(tree, q("""{"role":"TextView"}""")).map { it.name })
        assertFalse(findAll(tree, q("{}")).any { it === tree })
    }

    @Test fun readSubtreeReadsItemsAndFromFields() {
        val spec = JSONObject("""{
          "itemQuery":{"role":"ViewGroup","path":[{"role":"RecyclerView"}]},
          "fields":{"title":{"read":"name","from":{"role":"TextView"}},"whole":{"read":"name"},"missing":{"read":"name","from":{"role":"Button"}}},
          "dedupeBy":"title"}""")
        assertEquals(
            listOf(
                mapOf("title" to "麦当劳", "whole" to "麦当劳 月售 9999+", "missing" to ""),
                mapOf("title" to "肯德基", "whole" to "肯德基 月售 5000+", "missing" to ""),
            ),
            readSubtree(tree, spec),
        )
    }

    @Test fun valueReadsTheTextNotTheDescription() {
        val t = n("FrameLayout", "", FakeNode("EditText", name = "地址", text = "公司"))
        val spec = JSONObject("""{"itemQuery":{"role":"EditText"},"fields":{"v":{"read":"value"}},"dedupeBy":"v"}""")
        assertEquals(listOf(mapOf("v" to "公司")), readSubtree(t, spec))
    }

    @Test fun aMisspeltReadIsRejected() {
        val spec = JSONObject("""{"itemQuery":{"role":"EditText"},"fields":{"v":{"read":"vlaue"}},"dedupeBy":"v"}""")
        assertThrows(IllegalArgumentException::class.java) { readSubtree(n("FrameLayout"), spec) }
    }
}
