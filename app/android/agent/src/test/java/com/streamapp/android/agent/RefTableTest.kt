package com.streamapp.android.agent

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

private fun rfp(
    name: String,
    viewId: String = "",
    rect: Rect = Rect(0, 0, 10, 10),
    editable: Boolean = false,
    hint: Boolean = false,
    inList: Boolean = false,
    context: String? = null,
) = ElementFp("Button", "android.widget.Button", name, name, viewId, rect, editable, hint, inList, context)

private fun neverChanged(version: Long, windowId: String, rect: Rect) = false

/** Refs persist across reads; the same control keeps its ref; retired numbers are never reused. */
class RefTableTest {
    @Test fun aNewElementGetsARefAndResolveReturnsIt() {
        val t = RefTable<String>()
        val refs = t.snapshot(listOf("a", "b"), listOf(rfp("甲"), rfp("乙")), emptyList(), "w", 1, 1080, ::neverChanged)
        assertEquals("a", t.resolve(refs[0]).value)
        assertEquals("b", t.resolve(refs[1]).value)
    }

    @Test fun theSameControlKeepsItsRefAcrossReads() {
        val t = RefTable<String>()
        val first = t.snapshot(listOf("a"), listOf(rfp("甲", rect = Rect(10, 10, 50, 40))), emptyList(), "w", 1, 1080, ::neverChanged)
        val second = t.snapshot(listOf("a'"), listOf(rfp("甲", rect = Rect(12, 12, 50, 40))), emptyList(), "w", 2, 1080, ::neverChanged)
        assertEquals(first[0], second[0])
        assertEquals("a'", t.resolve(second[0]).value)
    }

    @Test fun aRefSurvivesReadsThatDoNotIncludeItsElement() {
        val t = RefTable<String>()
        val first = t.snapshot(listOf("a"), listOf(rfp("甲")), emptyList(), "w", 1, 1080, ::neverChanged)
        t.snapshot(listOf("b"), listOf(rfp("乙")), emptyList(), "w", 2, 1080, ::neverChanged)
        assertEquals("a", t.resolve(first[0]).value)
    }

    @Test fun anUnrecognizableElementAlwaysGetsANewRef() {
        val t = RefTable<String>()
        val first = t.snapshot(listOf("a"), listOf(rfp("")), emptyList(), "w", 1, 1080, ::neverChanged)
        val second = t.snapshot(listOf("a'"), listOf(rfp("")), emptyList(), "w", 2, 1080, ::neverChanged)
        assertNotEquals(first[0], second[0])
    }

    @Test fun anAmbiguousIdentityNeverGetsReused() {
        val t = RefTable<String>()
        val fps = listOf(rfp("行"), rfp("行", rect = Rect(0, 100, 10, 10)))
        val first = t.snapshot(listOf("a1", "a2"), fps, emptyList(), "w", 1, 1080, ::neverChanged)
        val second = t.snapshot(listOf("b1", "b2"), fps, emptyList(), "w", 2, 1080, ::neverChanged)
        assertNotEquals(first[0], second[0])
        assertNotEquals(first[1], second[1])
    }

    @Test fun anElementAnotherReadAlsoMatchesStaysPut() {
        // Two reads both containing the same control plus another read matching an older
        // ambiguous entry: uniqueness in the new read decides.
        val t = RefTable<String>()
        val first = t.snapshot(listOf("a"), listOf(rfp("甲")), emptyList(), "w", 1, 1080, ::neverChanged)
        val second = t.snapshot(listOf("b", "c"), listOf(rfp("甲"), rfp("乙")), emptyList(), "w", 2, 1080, ::neverChanged)
        assertEquals(first[0], second[0])
    }

    @Test fun aListRowOnlyCarriesOverInPlace() {
        val t = RefTable<String>()
        val fps = listOf(rfp("行", rect = Rect(0, 500, 1080, 80), inList = true))
        val first = t.snapshot(listOf("a"), fps, emptyList(), "w", 1, 1080, ::neverChanged)
        // 3% of the short edge away: outside the 2% in-place band, inside the 15% one.
        val second = t.snapshot(listOf("a'"), listOf(rfp("行", rect = Rect(0, 540, 1080, 80), inList = true)), emptyList(), "w", 2, 1080, ::neverChanged)
        assertNotEquals(first[0], second[0])
    }

    @Test fun aFarMoveNeverCarriesOver() {
        val t = RefTable<String>()
        val first = t.snapshot(listOf("a"), listOf(rfp("甲", rect = Rect(0, 0, 10, 10))), emptyList(), "w", 1, 1080, ::neverChanged)
        val second = t.snapshot(listOf("a'"), listOf(rfp("甲", rect = Rect(900, 2300, 10, 10))), emptyList(), "w", 2, 1080, ::neverChanged)
        assertNotEquals(first[0], second[0])
    }

    @Test fun aChangeSinceTheLastReadStopsTheCarryOver() {
        val t = RefTable<String>()
        var changedRects = emptyList<Rect>()
        val changed = { v: Long, w: String, r: Rect -> changedRects.any { it.intersects(r) } }
        val first = t.snapshot(listOf("a"), listOf(rfp("甲", rect = Rect(0, 0, 10, 10))), emptyList(), "w", 1, 1080, changed)
        changedRects = listOf(Rect(0, 0, 10, 10))
        val second = t.snapshot(listOf("a'"), listOf(rfp("甲", rect = Rect(0, 0, 10, 10))), emptyList(), "w", 2, 1080, changed)
        assertNotEquals(first[0], second[0])
    }

    @Test fun refsFromAnotherWindowDoNotCarryOver() {
        val t = RefTable<String>()
        val first = t.snapshot(listOf("a"), listOf(rfp("甲")), emptyList(), "w1", 1, 1080, ::neverChanged)
        val second = t.snapshot(listOf("a'"), listOf(rfp("甲")), emptyList(), "w2", 2, 1080, ::neverChanged)
        assertNotEquals(first[0], second[0])
    }

    @Test fun retiredNumbersAreNeverReused() {
        val t = RefTable<String>(capacity = 2)
        val a = t.snapshot(listOf("1"), listOf(rfp("甲")), emptyList(), "w", 1, 1080, ::neverChanged)
        t.snapshot(listOf("2"), listOf(rfp("乙")), emptyList(), "w", 2, 1080, ::neverChanged)
        t.snapshot(listOf("3"), listOf(rfp("丙")), emptyList(), "w", 3, 1080, ::neverChanged)
        val d = t.snapshot(listOf("4"), listOf(rfp("丁")), emptyList(), "w", 4, 1080, ::neverChanged)
        assertNotEquals(a[0], d[0])
        // "a"'s number was retired (evicted); resolving it is not a crash and not a fresh ref.
        val e = assertThrows(StaleRefException::class.java) { t.resolve(a[0]) }
        assertEquals("ref_not_in_snapshot", e.kind)
        assertEquals(a[0], e.ref)
    }

    // ---- stale kinds ------------------------------------------------------------------

    @Test fun unknownShapesAndNumbersAreSnapshotUnknown() {
        val t = RefTable<String>()
        t.snapshot(listOf("a"), listOf(rfp("甲")), emptyList(), "w", 1, 1080, ::neverChanged)
        assertEquals("snapshot_unknown", staleKindOf { t.resolve("zzz") })
        assertEquals("snapshot_unknown", staleKindOf { t.resolve("g1-0") })
        assertEquals("snapshot_unknown", staleKindOf { t.resolve("r99999") })
        assertEquals("snapshot_unknown", staleKindOf { t.resolve("r-1") })
    }

    @Test fun aDroppedNumberIsNotInSnapshot() {
        val t = RefTable<String>(capacity = 1)
        val a = t.snapshot(listOf("a"), listOf(rfp("甲")), emptyList(), "w", 1, 1080, ::neverChanged)
        t.snapshot(listOf("b"), listOf(rfp("乙")), emptyList(), "w", 2, 1080, ::neverChanged)
        assertEquals("ref_not_in_snapshot", staleKindOf { t.resolve(a[0]) })
    }

    @Test fun theErrorCarriesCodeAndSemantics() {
        val t = RefTable<String>()
        t.snapshot(listOf("a"), listOf(rfp("甲")), emptyList(), "w", 1, 1080, ::neverChanged)
        try {
            t.resolve("r99999"); fail("expected stale-ref")
        } catch (e: StaleRefException) {
            assertEquals("stale-ref", e.errorCode)
            assertTrue(e.message!!.startsWith("stale-ref:"))
            assertEquals("snapshot_unknown", e.semantics!!.getString("kind"))
            assertEquals("r99999", e.semantics!!.getString("ref"))
        }
    }

    private fun staleKindOf(block: () -> Unit): String =
        try { block(); fail("expected stale-ref"); "" } catch (e: StaleRefException) { e.kind }
}
