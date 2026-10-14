package com.streamapp.android.net

import com.streamapp.android.agent.ANDROID_OPS
import com.streamapp.android.agent.Dispatcher
import com.streamapp.android.protocol.Backoff
import com.streamapp.android.protocol.DeviceState
import com.streamapp.android.protocol.Frames
import com.streamapp.android.protocol.wsUrl

data class Creds(val backend: String, val deviceId: String, val token: String)

interface Transport {
    fun open(url: String, protocols: List<String>, listener: Listener)
    fun send(text: String): Boolean
    fun close(code: Int, reason: String)
    interface Listener {
        fun onOpen()
        fun onMessage(text: String)
        fun onClosed(code: Int, reason: String)
        fun onFailure(error: String)
    }
}

/**
 * The connection's decisions, with no Android in it: hello first, then state; requests run one
 * at a time on [executor]; 4003 means the backend no longer accepts this phone, anything else
 * reconnects with backoff. A fresh [Dispatcher] per connection, so a reconnect never reuses
 * refs or a scope from before.
 */
class RelayClient(
    private val transport: Transport,
    private val dispatcher: () -> Dispatcher,
    private val name: String,
    private val agentVersion: String,
    private val stateProvider: () -> DeviceState,
    private val executor: (Runnable) -> Unit,
    private val schedule: (Long, Runnable) -> () -> Unit,
    private val backoff: Backoff = Backoff(),
    private val callbacks: Callbacks,
) {
    interface Callbacks {
        fun status(text: String)
        fun revoked(reason: String)
    }

    @Volatile private var open = false
    @Volatile private var stopped = false
    @Volatile private var gen = 0
    private var creds: Creds? = null
    private var current: Dispatcher? = null
    private var cancelReconnect: (() -> Unit)? = null

    fun start(c: Creds) {
        cancelReconnect?.invoke()
        cancelReconnect = null
        creds = c
        stopped = false
        open = false
        val g = ++gen
        callbacks.status("正在连接 ${c.backend}")
        transport.open(wsUrl(c.backend), listOf(Frames.PROTOCOL, c.token), listenerFor(g))
    }

    fun stop() {
        stopped = true
        open = false
        cancelReconnect?.invoke()
        cancelReconnect = null
        transport.close(1000, "stopped")
    }

    fun sendState() { if (open) transport.send(Frames.state(stateProvider())) }

    fun abort() { if (open) transport.send(Frames.abort()) }

    private fun listenerFor(g: Int) = object : Transport.Listener {
        override fun onOpen() {
            if (stopped || g != gen) return
            val c = creds ?: return
            backoff.reset()
            current = dispatcher()
            transport.send(Frames.hello(c.deviceId, name, agentVersion, ANDROID_OPS))
            transport.send(Frames.state(stateProvider()))
            open = true
            callbacks.status("已连接 ${c.backend}")
        }

        override fun onMessage(text: String) {
            if (g != gen) return
            val req = Frames.request(text) ?: return
            val d = current ?: return
            executor(Runnable {
                val reply = try {
                    Frames.reply(req.id, d.dispatch(req.op, req.args))
                } catch (t: Throwable) {
                    Frames.error(req.id, t.message ?: t.javaClass.simpleName)
                }
                if (g == gen && open) transport.send(reply)
            })
        }

        override fun onClosed(code: Int, reason: String) {
            if (g != gen) return
            open = false
            if (code == 4003) {
                stopped = true
                callbacks.revoked(reason)
                return
            }
            retry("连接断开（$code）")
        }

        override fun onFailure(error: String) {
            if (g != gen) return
            open = false
            retry("连不上：$error")
        }
    }

    private fun retry(why: String) {
        if (stopped) return
        val c = creds ?: return
        val ms = backoff.next()
        callbacks.status("$why，${ms / 1000} 秒后重连")
        cancelReconnect = schedule(ms, Runnable { if (!stopped) start(c) })
    }
}
