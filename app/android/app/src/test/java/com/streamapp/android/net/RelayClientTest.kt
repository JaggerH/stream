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
        val listeners = mutableListOf<Transport.Listener>()
        var listener: Transport.Listener? = null
        val sent = mutableListOf<String>()
        val opened = mutableListOf<Pair<String, List<String>>>()
        var closed: Int? = null
        override fun open(url: String, protocols: List<String>, listener: Transport.Listener) { opened += url to protocols; this.listener = listener; listeners += listener }
        override fun send(text: String): Boolean { sent += text; return true }
        override fun close(code: Int, reason: String) { closed = code }
    }

    private val creds = Creds("http://10.9.8.21:8900", "android:abc", "tok")
    private val state = DeviceState(true, true, false, 90, false)
    private val scheduled = mutableListOf<Long>()
    private var cancels = 0
    private val queued = mutableListOf<Runnable>()
    private var deferred = false
    private var revokedWith: String? = null

    private fun client(t: FakeTransport, dev: Device = FakeDevice()) = RelayClient(
        transport = t,
        dispatcher = { Dispatcher(dev) },
        name = "K80", agentVersion = "0.1.0",
        stateProvider = { state },
        executor = { if (deferred) queued += it else it.run() },
        schedule = { ms, _ -> scheduled += ms; { cancels++ } },
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

    @Test fun aReplyNeverCrossesToANewConnection() {
        val t = FakeTransport()
        val c = client(t)
        deferred = true
        c.start(creds)
        t.listeners[0].onOpen()
        t.listeners[0].onMessage("""{"id":5,"op":"url"}""")
        t.listeners[0].onClosed(1006, "")
        c.start(creds)
        assertEquals(2, t.listeners.size)
        val before = t.sent.size
        queued.forEach { it.run() }
        assertEquals(before, t.sent.size)
    }

    @Test fun aStaleReplyIsDroppedEvenAfterTheNewConnectionOpens() {
        val t = FakeTransport()
        val c = client(t)
        deferred = true
        c.start(creds)
        t.listeners[0].onOpen()
        t.listeners[0].onMessage("""{"id":5,"op":"url"}""")
        t.listeners[0].onClosed(1006, "")
        c.start(creds)
        t.listeners[1].onOpen()
        val before = t.sent.size
        queued.forEach { it.run() }
        assertEquals(before, t.sent.size)
    }

    @Test fun nothingIsSentBeforeOnOpenAndHelloComesFirst() {
        val t = FakeTransport()
        val c = client(t)
        c.start(creds)
        c.sendState()
        c.abort()
        assertTrue(t.sent.isEmpty())
        t.listener!!.onOpen()
        assertEquals("hello", JSONObject(t.sent[0]).getString("type"))
        assertEquals("state", JSONObject(t.sent[1]).getString("type"))
    }

    @Test fun stopCancelsAPendingReconnectAndALateFailureSchedulesNothing() {
        val t = FakeTransport()
        val c = client(t)
        c.start(creds)
        t.listener!!.onFailure("x")
        assertEquals(1, scheduled.size)
        c.stop()
        assertTrue(cancels >= 1)
        t.listener!!.onFailure("late")
        assertEquals(1, scheduled.size)
    }

    @Test fun callbacksFromAnOlderConnectionAreIgnored() {
        val t = FakeTransport()
        val c = client(t)
        c.start(creds)
        val old = t.listeners[0]
        c.start(creds)
        old.onClosed(4003, "revoked")
        assertNull(revokedWith)
    }

    private val tap = """{"id":7,"op":"click","args":{"rect":{"x":0,"y":0,"w":2,"h":2}}}"""

    /** Queue a tap on connection 1, let [cut] end it, then drain the queue. */
    private fun queuedTapAfter(cut: (RelayClient, FakeTransport) -> Unit): FakeDevice {
        val t = FakeTransport()
        val dev = FakeDevice()
        val c = client(t, dev)
        deferred = true
        c.start(creds)
        t.listeners[0].onOpen()
        t.listeners[0].onMessage(tap)
        cut(c, t)
        queued.toList().forEach { it.run() }
        return dev
    }

    @Test fun aRequestQueuedBeforeAReconnectNeverTouchesThePhone() {
        val dev = queuedTapAfter { c, t ->
            t.listeners[0].onClosed(1006, "")
            c.start(creds)
            t.listeners[1].onOpen()
        }
        assertTrue(dev.log.toString(), dev.log.isEmpty())
    }

    @Test fun aRequestQueuedBeforeStopNeverTouchesThePhone() {
        val dev = queuedTapAfter { c, _ -> c.stop() }
        assertTrue(dev.log.toString(), dev.log.isEmpty())
    }

    @Test fun aRequestQueuedBeforeARevokeNeverTouchesThePhone() {
        val dev = queuedTapAfter { _, t -> t.listeners[0].onClosed(4003, "revoked") }
        assertTrue(dev.log.toString(), dev.log.isEmpty())
    }

    @Test fun aRequestQueuedBeforeAbortNeverTouchesThePhone() {
        val dev = queuedTapAfter { c, _ -> c.abort() }
        assertTrue(dev.log.toString(), dev.log.isEmpty())
    }

    @Test fun aDisconnectStopsTheRunningRequestAtItsNextAction() {
        val t = FakeTransport()
        val dev = FakeDevice()
        client(t, dev).start(creds)
        t.listener!!.onOpen()
        dev.after = { if (it.startsWith("swipe")) t.listeners[0].onClosed(1006, "") }
        t.listener!!.onMessage("""{"id":8,"op":"scroll","args":{"dir":"down","amount":10}}""")
        assertEquals(1, dev.log.count { it.startsWith("swipe") })
    }

    @Test fun abortStopsTheRunningRequestButNotTheNextOne() {
        val t = FakeTransport()
        val dev = FakeDevice()
        val c = client(t, dev)
        c.start(creds)
        t.listener!!.onOpen()
        dev.after = { if (it.startsWith("swipe")) c.abort() }
        t.listener!!.onMessage("""{"id":8,"op":"scroll","args":{"dir":"down","amount":10}}""")
        assertEquals(1, dev.log.count { it.startsWith("swipe") })
        val failed = t.sent.map { JSONObject(it) }.single { it.optInt("id") == 8 }
        assertTrue(failed.toString(), failed.getString("error").startsWith("aborted:"))
        dev.after = {}
        t.listener!!.onMessage(tap)
        assertTrue(dev.log.toString(), "tap 1,1 long=false" in dev.log)
        assertFalse(t.sent.map { JSONObject(it) }.single { it.optInt("id") == 7 }.has("error"))
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
