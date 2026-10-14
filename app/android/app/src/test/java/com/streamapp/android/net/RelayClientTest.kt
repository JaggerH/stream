package com.streamapp.android.net

import com.streamapp.android.agent.Device
import com.streamapp.android.agent.Dispatcher
import com.streamapp.android.agent.FakeDevice
import com.streamapp.android.protocol.Backoff
import com.streamapp.android.protocol.DeviceState
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class RelayClientTest {
    class FakeTransport : Transport {
        var listener: Transport.Listener? = null
        val sent = mutableListOf<String>()
        val opened = mutableListOf<Pair<String, List<String>>>()
        var closed: Int? = null
        override fun open(url: String, protocols: List<String>, listener: Transport.Listener) { opened += url to protocols; this.listener = listener }
        override fun send(text: String): Boolean { sent += text; return true }
        override fun close(code: Int, reason: String) { closed = code }
    }

    private val creds = Creds("http://10.9.8.21:8900", "android:abc", "tok")
    private val state = DeviceState(true, true, false, 90, false)
    private val scheduled = mutableListOf<Long>()
    private var revokedWith: String? = null

    private fun client(t: FakeTransport, dev: Device = FakeDevice()) = RelayClient(
        transport = t,
        dispatcher = { Dispatcher(dev) },
        name = "K80", agentVersion = "0.1.0",
        stateProvider = { state },
        executor = { it.run() },
        schedule = { ms, _ -> scheduled += ms },
        backoff = Backoff(jitter = { 0.0 }),
        callbacks = object : RelayClient.Callbacks {
            override fun status(text: String) {}
            override fun revoked(reason: String) { revokedWith = reason }
        },
    )

    @Test fun offersTheProtocolAndTokenThenSaysHelloAndState() {
        val t = FakeTransport()
        client(t).start(creds)
        assertEquals("ws://10.9.8.21:8900/api/host" to listOf("host-relay.v2", "tok"), t.opened.single())
        t.listener!!.onOpen()
        assertEquals("hello", JSONObject(t.sent[0]).getString("type"))
        assertEquals("android:abc", JSONObject(t.sent[0]).getString("deviceId"))
        assertEquals("state", JSONObject(t.sent[1]).getString("type"))
    }

    @Test fun answersRequestsAndErrors() {
        val t = FakeTransport()
        client(t).start(creds)
        t.listener!!.onOpen()
        t.listener!!.onMessage("""{"id":5,"op":"url"}""")
        t.listener!!.onMessage("""{"id":6,"op":"readText"}""")
        assertEquals("com.sankuai.meituan/.Main", JSONObject(t.sent[2]).getString("result"))
        assertEquals("unknown op: readText", JSONObject(t.sent[3]).getString("error"))
    }

    @Test fun ignoresFramesThatAreNotRequests() {
        val t = FakeTransport()
        client(t).start(creds)
        t.listener!!.onOpen()
        t.listener!!.onMessage("""{"type":"something"}""")
        assertEquals(2, t.sent.size)
    }

    @Test fun reconnectsWithBackoffButStopsOnRevoke() {
        val t = FakeTransport()
        val c = client(t)
        c.start(creds)
        t.listener!!.onFailure("connection refused")
        t.listener!!.onClosed(1006, "")
        assertEquals(listOf(1000L, 2000L), scheduled)
        t.listener!!.onClosed(4003, "revoked")
        assertEquals("revoked", revokedWith)
        assertEquals(2, scheduled.size)
    }

    @Test fun aSuccessfulOpenResetsTheBackoff() {
        val t = FakeTransport()
        client(t).start(creds)
        t.listener!!.onFailure("x")
        t.listener!!.onOpen()
        t.listener!!.onClosed(1006, "")
        assertEquals(listOf(1000L, 1000L), scheduled)
    }

    @Test fun abortSendsTheAbortFrame() {
        val t = FakeTransport()
        val c = client(t)
        c.start(creds)
        t.listener!!.onOpen()
        c.abort()
        assertEquals("abort", JSONObject(t.sent.last()).getString("type"))
    }
}
