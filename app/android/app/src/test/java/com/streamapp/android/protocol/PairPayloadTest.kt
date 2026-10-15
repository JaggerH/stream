package com.streamapp.android.protocol

import org.junit.Assert.*
import org.junit.Test

class PairPayloadTest {
    @Test fun parsesThePanelQrWithEveryAddress() {
        val p = PairPayload.parse("""{"stream":"pair","v":1,"backend":"http://10.9.8.21:8900","backends":["http://10.9.8.21:8900","http://100.70.0.5:8900/"],"code":"123456"}""")!!
        assertEquals(listOf("http://10.9.8.21:8900", "http://100.70.0.5:8900"), p.backends)
        assertEquals("123456", p.code)
    }

    @Test fun anAddressThatIsNotHttpIsDroppedAndNoneLeftIsNoPayload() {
        assertEquals(listOf("http://h:1"), PairPayload.parse("""{"stream":"pair","v":1,"backends":["ftp://x","http://h:1"],"code":"123456"}""")!!.backends)
        assertNull(PairPayload.parse("""{"stream":"pair","v":1,"backends":["ftp://x"],"code":"123456"}"""))
        // The interim v2 form (backends only) is read as well.
        assertEquals(listOf("http://h:1"), PairPayload.parse("""{"stream":"pair","v":2,"backends":["http://h:1"],"code":"123456"}""")!!.backends)
    }

    @Test fun stillReadsTheOneAddressQr() {
        val p = PairPayload.parse("""{"stream":"pair","v":1,"backend":"http://h:1/","code":"000001"}""")!!
        assertEquals(listOf("http://h:1"), p.backends)
    }

    @Test fun rejectsOtherQrCodes() {
        assertNull(PairPayload.parse("https://example.com"))
        assertNull(PairPayload.parse("""{"stream":"pair","v":3,"backends":["http://h:1"],"code":"123456"}"""))
        assertNull(PairPayload.parse("""{"stream":"pair","v":1,"backend":"ftp://h","code":"123456"}"""))
        assertNull(PairPayload.parse("""{"stream":"pair","v":1,"backend":"http://h:1","code":"12345"}"""))
    }

    @Test fun manualEntryBuildsTheSamePayload() {
        val p = PairPayload.manual(" 10.9.8.21:8900 ", " 654321 ")!!
        assertEquals(listOf("http://10.9.8.21:8900"), p.backends)
        assertEquals("654321", p.code)
        assertNull(PairPayload.manual("10.9.8.21:8900", "abc"))
    }

    @Test fun choicesPutReachableAddressesFirstAndSayWhichNetwork() {
        val c = pairChoices(
            listOf("http://100.70.0.5:8900", "http://10.9.8.21:8900", "http://192.168.1.5:8900"),
            reachable = mapOf("http://10.9.8.21:8900" to true, "http://100.70.0.5:8900" to false),
        )
        assertEquals(listOf("http://10.9.8.21:8900", "http://192.168.1.5:8900", "http://100.70.0.5:8900"), c.map { it.backend })
        assertEquals("10.9.8.21:8900 · 局域网 · 能连上", c[0].label)
        assertEquals("192.168.1.5:8900 · 局域网 · 没测出来", c[1].label)
        assertEquals("100.70.0.5:8900 · Tailscale · 连不上", c[2].label)
    }

    @Test fun amongReachableAddressesTheLanComesFirst() {
        val c = pairChoices(listOf("http://100.70.0.5:8900", "http://10.9.8.21:8900"), mapOf("http://100.70.0.5:8900" to true, "http://10.9.8.21:8900" to true))
        assertEquals(listOf("http://10.9.8.21:8900", "http://100.70.0.5:8900"), c.map { it.backend })
    }

    @Test fun wsUrlFollowsTheScheme() {
        assertEquals("ws://h:1/api/host", wsUrl("http://h:1"))
        assertEquals("wss://h/api/host", wsUrl("https://h"))
    }
}
