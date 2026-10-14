package com.streamapp.android.net

import org.junit.Assert.*
import org.junit.Test

class PairingTest {
    @Test fun successGivesCredentials() {
        val c = Pairing.parseResponse(200, """{"deviceId":"android:1","deviceToken":"t"}""", "http://h:1").getOrThrow()
        assertEquals(Creds("http://h:1", "android:1", "t"), c)
    }

    @Test fun backendErrorTextIsShownAsIs() {
        val e = Pairing.parseResponse(403, """{"error":"配对码已过期"}""", "http://h:1").exceptionOrNull()!!
        assertEquals("配对码已过期", e.message)
    }

    @Test fun nonJsonBodyNamesTheStatus() {
        assertEquals("配对失败（HTTP 502）", Pairing.parseResponse(502, "<html>", "http://h:1").exceptionOrNull()!!.message)
    }
}
