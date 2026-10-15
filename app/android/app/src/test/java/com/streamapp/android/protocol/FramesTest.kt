package com.streamapp.android.protocol

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class FramesTest {
    @Test fun parsesARequestWithArgs() {
        val r = Frames.request("""{"id":7,"op":"find","args":{"query":{"role":"Button"}}}""")!!
        assertEquals(7L, r.id)
        assertEquals("find", r.op)
        assertEquals("Button", r.args.getJSONObject("query").getString("role"))
    }

    @Test fun argsDefaultToEmptyObject() {
        assertEquals(0, Frames.request("""{"id":1,"op":"url"}""")!!.args.length())
    }

    @Test fun rejectsFramesThatAreNotRequests() {
        assertNull(Frames.request("""{"op":"url"}"""))
        assertNull(Frames.request("""{"id":"1","op":"url"}"""))
        assertNull(Frames.request("""{"id":1}"""))
        assertNull(Frames.request("nope"))
    }

    @Test fun replyCarriesNullResultExplicitly() {
        val o = JSONObject(Frames.reply(3, null))
        assertEquals(3, o.getInt("id"))
        assertTrue(o.has("result"))
        assertTrue(o.isNull("result"))
    }

    @Test fun errorFrame() {
        val o = JSONObject(Frames.error(4, "stale-ref: n1"))
        assertEquals("stale-ref: n1", o.getString("error"))
        assertFalse(o.has("result"))
    }

    @Test fun helloDeclaresAndroid() {
        val o = JSONObject(Frames.hello("android:x", "K80", "0.1.0", listOf("find", "url")))
        assertEquals("hello", o.getString("type"))
        assertEquals("android", o.getString("platform"))
        assertEquals("android:x", o.getString("deviceId"))
        assertEquals(2, o.getJSONArray("ops").length())
    }

    @Test fun stateFrame() {
        val o = JSONObject(Frames.state(DeviceState(a11yEnabled = false, screenOn = true, keyguardLocked = false, battery = 77, charging = true)))
        assertEquals("state", o.getString("type"))
        assertFalse(o.getBoolean("a11yEnabled"))
        assertEquals(77, o.getInt("battery"))
    }

    @Test fun abortFrame() {
        val o = JSONObject(Frames.abort())
        assertEquals("abort", o.getString("type"))
        assertEquals("phone-stop", o.getString("reason")) // the backend words the abort as a tap on the phone
    }
}
