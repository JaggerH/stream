package com.streamapp.android.net

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.util.Log
import com.streamapp.android.AgentConnection
import com.streamapp.android.agentlib.R
import com.streamapp.android.StreamAgent
import com.streamapp.android.a11y.AndroidDevice
import com.streamapp.android.a11y.StreamAccessibilityService
import com.streamapp.android.agent.Dispatcher
import com.streamapp.android.agent.Occupancy
import com.streamapp.android.ocr.TesseractOcrEngine
import com.streamapp.android.policy.PolicyContext
import com.streamapp.android.protocol.DeviceState
import com.streamapp.android.store.Credentials
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Owns the connection while the app is paired (design D5): a foreground service, so the OS
 *  keeps it, with a persistent notification that says whether Stream is connected. */
internal class RelayService : Service() {
    private val http = OkHttpClient.Builder().pingInterval(25, TimeUnit.SECONDS).build()
    private val worker = Executors.newSingleThreadExecutor()
    private val timers = HandlerThread("stream-relay").apply { start() }
    private val handler by lazy { Handler(timers.looper) }
    private var client: RelayClient? = null
    private val heartbeat = object : Runnable {
        override fun run() { client?.sendState(); handler.postDelayed(this, 30_000) }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTE_ID, note(getString(R.string.stream_agent_notification_connecting)), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            } else {
                startForeground(NOTE_ID, note(getString(R.string.stream_agent_notification_connecting)))
            }
        } catch (e: RuntimeException) {
            // ForegroundServiceStartNotAllowedException (API 31+) when started from the background.
            Log.w("Stream", "startForeground refused", e)
            StreamAgent.publish(getString(R.string.stream_agent_start_refused), AgentConnection.START_REFUSED)
            stopSelf()
            return START_NOT_STICKY
        }
        val creds = Credentials.load(this) ?: run { stopSelf(); return START_NOT_STICKY }
        if (client == null) {
            // The indicator's Stop: the existing abort, then the embedding app's listener.
            val device = AndroidDevice(this) { StreamAgent.userStopped { client?.abort() } }
            val occupancy = Occupancy(hint = { StreamAgent.occupancyHint }, anyRecentTouch = { StreamAgent.anyRecentTouchOccupies })
            // The policy engine is process-lifetime: its lease id rotates when this service (and
            // with it the process state) starts over, so credentials issued before a restart fail
            // their binding check on replay.
            val policy = PolicyContext.fromStreams(
                { path -> assets.open(path) },
                creds.deviceId,
            )
            // The text tier's engine is process-lifetime and lazy: the models are fetched and the
            // native library loaded only when a read (or a blind coordinate tap) first needs them.
            val ocr = lazy { TesseractOcrEngine(this) }
            client = RelayClient(
                transport = OkHttpTransport(http),
                dispatcher = { Dispatcher(device, policy, occupancy, ocrEngine = { ocr.value }) },
                name = "${Build.MANUFACTURER} ${Build.MODEL}",
                agentVersion = StreamAgent.version,
                stateProvider = ::state,
                executor = { worker.execute(it) },
                schedule = { ms, r -> handler.postDelayed(r, ms); { handler.removeCallbacks(r) } },
                callbacks = object : RelayClient.Callbacks {
                    override fun status(text: String, phase: AgentConnection) = publish(text, phase)
                    override fun revoked(reason: String) {
                        Credentials.clear(this@RelayService)
                        publish(REVOKED_STATUS, AgentConnection.REVOKED)
                        stopSelf()
                    }
                },
            )
            StreamAccessibilityService.listener = { client?.sendState() }
            client!!.start(creds)
            handler.postDelayed(heartbeat, 30_000)
        }
        return START_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        client?.stop()
        client = null
        StreamAccessibilityService.listener = null
        if (StreamAgent.connection != AgentConnection.REVOKED) StreamAgent.setConnection(AgentConnection.IDLE)
        timers.quitSafely()
        worker.shutdownNow()
        super.onDestroy()
    }

    private fun state(): DeviceState = probeDeviceState(this)

    private fun publish(text: String, phase: AgentConnection) {
        StreamAgent.publish(text, phase)
        getSystemService(NotificationManager::class.java).notify(NOTE_ID, note(text))
    }

    private fun note(text: String): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, getString(R.string.stream_agent_notification_channel), NotificationManager.IMPORTANCE_LOW))
        // Tapping it opens the embedding app's launcher activity, addressed by component alone.
        val launcher = packageManager.getLaunchIntentForPackage(packageName)?.component
        val open = launcher?.let { PendingIntent.getActivity(this, 0, Intent().setComponent(it), PendingIntent.FLAG_IMMUTABLE) }
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setContentTitle(getString(R.string.stream_agent_notification_title))
            .setContentText(text)
            .setOngoing(true)
            .apply { if (open != null) setContentIntent(open) }
            .build()
    }

    companion object {
        private const val CHANNEL = "relay"
        private const val NOTE_ID = 1
        fun start(ctx: Context) { ctx.startForegroundService(Intent(ctx, RelayService::class.java)) }
        fun stop(ctx: Context) { ctx.stopService(Intent(ctx, RelayService::class.java)) }
    }
}

/** OkHttp's WebSocket behind [Transport]. OkHttp sends no Origin header, which `/api/host` requires. */
internal class OkHttpTransport(private val http: OkHttpClient) : Transport {
    private var ws: WebSocket? = null

    override fun open(url: String, protocols: List<String>, listener: Transport.Listener) {
        val req = Request.Builder().url(url).header("Sec-WebSocket-Protocol", protocols.joinToString(", ")).build()
        ws?.cancel()
        ws = http.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = listener.onOpen()
            override fun onMessage(webSocket: WebSocket, text: String) = listener.onMessage(text)
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                listener.onClosing(code, reason)
                webSocket.close(1000, null)
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = listener.onClosed(code, reason)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) =
                if (response?.code == 401) listener.onClosed(4003, "unauthorized") else listener.onFailure(t.message ?: t.javaClass.simpleName)
        })
    }

    override fun send(text: String) = ws?.send(text) ?: false
    override fun close(code: Int, reason: String) { ws?.close(code, reason) }
}
