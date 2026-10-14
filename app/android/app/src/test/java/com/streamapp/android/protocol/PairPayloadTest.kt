package com.streamapp.android.protocol

import org.junit.Assert.*
import org.junit.Test

class PairPayloadTest {
    @Test fun parsesThePanelQr() {
        val p = PairPayload.parse("""{"stream":"pair","v":1,"backend":"http://10.9.8.21:8900","code":"123456"}""")!!
        assertEquals("http://10.9.8.21:8900", p.backend)
        assertEquals("123456", p.code)
    }

    @Test fun stripsATrailingSlash() {
        assertEquals("http://h:1", PairPayload.parse("""{"stream":"pair","v":1,"backend":"http://h:1/","code":"000001"}""")!!.backend)
    }

    @Test fun rejectsOtherQrCodes() {
        assertNull(PairPayload.parse("https://example.com"))
        assertNull(PairPayload.parse("""{"stream":"pair","v":2,"backend":"http://h:1","code":"123456"}"""))
        assertNull(PairPayload.parse("""{"stream":"pair","v":1,"backend":"ftp://h","code":"123456"}"""))
        assertNull(PairPayload.parse("""{"stream":"pair","v":1,"backend":"http://h:1","code":"12345"}"""))
    }

    @Test fun manualEntryBuildsTheSamePayload() {
        val p = PairPayload.manual(" 10.9.8.21:8900 ", " 654321 ")!!
        assertEquals("http://10.9.8.21:8900", p.backend)
        assertEquals("654321", p.code)
        assertNull(PairPayload.manual("10.9.8.21:8900", "abc"))
    }

    @Test fun wsUrlFollowsTheScheme() {
        assertEquals("ws://h:1/api/host", wsUrl("http://h:1"))
        assertEquals("wss://h/api/host", wsUrl("https://h"))
    }
}
