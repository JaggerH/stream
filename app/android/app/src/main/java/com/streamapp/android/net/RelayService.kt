package com.streamapp.android.net

import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import com.streamapp.android.BuildConfig
import com.streamapp.android.a11y.AndroidDevice
import com.streamapp.android.a11y.StreamAccessibilityService
import com.streamapp.android.agent.Dispatcher
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
class RelayService : Service() {
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
                startForeground(NOTE_ID, note("正在连接"), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            } else {
                startForeground(NOTE_ID, note("正在连接"))
            }
        } catch (e: RuntimeException) {
            // ForegroundServiceStartNotAllowedException (API 31+) when started from the background.
            Log.w("Stream", "startForeground refused", e)
            statusText = "系统不允许后台启动连接，打开 Stream 一次即可恢复"
            onStatus?.invoke(statusText)
            stopSelf()
            return START_NOT_STICKY
        }
        val creds = Credentials.load(this) ?: run { stopSelf(); return START_NOT_STICKY }
        if (client == null) {
            val device = AndroidDevice(this) { client?.abort() }
            client = RelayClient(
                transport = OkHttpTransport(http),
                dispatcher = { Dispatcher(device) },
                name = "${Build.MANUFACTURER} ${Build.MODEL}",
                agentVersion = BuildConfig.VERSION_NAME,
                stateProvider = ::state,
                executor = { worker.execute(it) },
                schedule = { ms, r -> handler.postDelayed(r, ms); { handler.removeCallbacks(r) } },
                callbacks = object : RelayClient.Callbacks {
                    override fun status(text: String) = publish(text)
                    override fun revoked(reason: String) {
                        Credentials.clear(this@RelayService)
                        publish(REVOKED_STATUS)
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
        timers.quitSafely()
        worker.shutdownNow()
        super.onDestroy()
    }

    private fun state(): DeviceState {
        val pm = getSystemService(PowerManager::class.java)
        val km = getSystemService(KeyguardManager::class.java)
        val bat = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = bat?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = bat?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
        val plugged = (bat?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0) != 0
        return DeviceState(
            a11yEnabled = StreamAccessibilityService.instance != null,
            screenOn = pm.isInteractive,
            keyguardLocked = km.isKeyguardLocked,
            battery = if (level < 0) -1 else level * 100 / scale,
            charging = plugged,
        )
    }

    private fun publish(text: String) {
        statusText = text
        onStatus?.invoke(text)
        getSystemService(NotificationManager::class.java).notify(NOTE_ID, note(text))
    }

    private fun note(text: String): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Stream 连接", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 0, Intent(this, com.streamapp.android.ui.MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setContentTitle("Stream")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(open)
            .build()
    }

    companion object {
        private const val CHANNEL = "relay"
        private const val NOTE_ID = 1
        @Volatile var statusText: String = "未连接"
        @Volatile var onStatus: ((String) -> Unit)? = null

        fun start(ctx: Context) { ctx.startForegroundService(Intent(ctx, RelayService::class.java)) }
        fun stop(ctx: Context) { ctx.stopService(Intent(ctx, RelayService::class.java)) }
    }
}

/** OkHttp's WebSocket behind [Transport]. OkHttp sends no Origin header, which `/api/host` requires. */
class OkHttpTransport(private val http: OkHttpClient) : Transport {
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
