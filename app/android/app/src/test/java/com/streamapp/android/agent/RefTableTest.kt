package com.streamapp.android.agent

import org.junit.Assert.*
import org.junit.Test

class RefTableTest {
    @Test fun refsResolveWithinTheirSnapshot() {
        val t = RefTable<String>()
        val refs = t.snapshot(listOf("a", "b"))
        assertEquals("b", t.resolve(refs[1]))
    }

    @Test fun anOlderSnapshotsRefIsStale() {
        val t = RefTable<String>()
        val old = t.snapshot(listOf("a"))
        t.snapshot(listOf("x"))
        val e = assertThrows(StaleRefException::class.java) { t.resolve(old[0]) }
        assertTrue(e.message!!.startsWith("stale-ref:"))
    }

    @Test fun garbageRefIsStaleNotACrash() {
        assertThrows(StaleRefException::class.java) { RefTable<String>().resolve("zzz") }
    }

    @Test fun refsAreUniqueAcrossSnapshots() {
        val t = RefTable<String>()
        assertNotEquals(t.snapshot(listOf("a"))[0], t.snapshot(listOf("a"))[0])
    }
}
