package com.streamapp.android.policy

import com.streamapp.android.protocol.Control
import com.streamapp.android.protocol.Frames
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Control frames and error replies on the wire. */
class FramesPolicyTest {
    @Test fun controlFramesParse() {
        val c = Frames.control("""{"type":"control","control":"setBusy","busy":true,"reason":"审批中","id":7}""")!!
        assertEquals("setBusy", c.control)
        assertEquals(true, c.busy)
        assertEquals("审批中", c.reason)
        assertEquals(7L, c.id)
        val e = Frames.control("""{"type":"control","control":"exemptions","ask":[{"app":"com.tencent.mm","action":"send"}],"financeVisible":["com.eg.android.AlipayGphone"],"id":8}""")!!
        assertEquals(listOf("com.tencent.mm" to "send"), e.ask)
        assertEquals(listOf("com.eg.android.AlipayGphone"), e.financeVisible)
        assertNull(Frames.control("""{"id":1,"op":"click","args":{}}"""))
        assertNull(Frames.control("not json"))
        assertNull(Frames.control("""{"type":"abort","reason":"phone-stop"}"""))
        // A grant without an id never gets a reply.
        assertNull(Frames.control("""{"type":"control","control":"setBusy","busy":false}""")!!.id)
    }

    @Test fun errorRepliesCarryCodeAndSemantics() {
        val sem = JSONObject().put("op", "click").put("reasons", arrayOf("commit-label"))
        val f = Frames.error(5, "approval-required: 等审批", "approval-required", sem)
        val o = JSONObject(f)
        assertEquals(5, o.getLong("id"))
        assertEquals("approval-required: 等审批", o.getString("error"))
        assertEquals("approval-required", o.getString("code"))
        assertEquals("click", o.getJSONObject("semantics").getString("op"))
        // A plain error stays a plain error.
        val plain = JSONObject(Frames.error(6, "device-locked: 锁屏有密码"))
        assertEquals("device-locked: 锁屏有密码", plain.getString("error"))
        assertTrue(!plain.has("code") || plain.getString("code") == "device-locked")
        assertTrue(!plain.has("semantics"))
    }

    @Test fun requestParsingStillLeads() {
        val r = Frames.request("""{"id":3,"op":"click","args":{"rect":{"x":1}},"abortEpoch":2}""")!!
        assertEquals(3L, r.id)
        assertEquals("click", r.op)
        assertEquals(2L, r.abortEpoch)
        assertNull(Frames.control("""{"id":3,"op":"click","args":{}}"""))
    }
}
