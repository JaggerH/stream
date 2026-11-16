package com.streamapp.android

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.os.Build
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import com.streamapp.android.a11y.Overlay
import com.streamapp.android.a11y.StreamAccessibilityService
import com.streamapp.android.agent.stopFromIndicator
import com.streamapp.android.net.Pairing
import com.streamapp.android.net.RelayService
import com.streamapp.android.net.probeDeviceState
import com.streamapp.android.net.shownStatus
import com.streamapp.android.store.Credentials
import okhttp3.OkHttpClient
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The public entry point of the execution agent library, for the app that embeds it.
 *
 * The library brings its own components through manifest merging: the relay connection (a
 * foreground service), the accessibility service that performs ops, the takeover banner, a boot
 * receiver that reconnects a paired device, and a wake activity. A host only has to pair once,
 * start the connection, and point the user at the accessibility setting; [state] and [observe]
 * tell it how far along that is.
 *
 * Everything else in the library is `internal` and may change without notice.
 */
public object StreamAgent {
    /** The agent version this library reports to the backend. */
    public val version: String = com.streamapp.android.agentlib.BuildConfig.AGENT_VERSION

    // ---- pairing ----

    /**
     * Exchanges a one-time pairing [code] for this device's credentials on [backend]
     * (`http(s)://host:port`) and stores them, encrypted with a key held by Android Keystore.
     * Does not start the connection: call [start] after a success.
     *
     * Blocking network call: never on the main thread. The failure's message is user-readable.
     */
    public fun pair(context: Context, backend: String, code: String, name: String = defaultDeviceName()): Result<Unit> =
        Pairing.pair(backend, code, name, http).mapCatching { Credentials.save(context.applicationContext, it) }

    /** Whether `GET /api/health` on [backend] answers within a couple of seconds. Blocking. */
    public fun isReachable(backend: String): Boolean = Pairing.reachable(backend, http)

    /** The backend this device is paired with, or null when it is not paired. */
    public fun pairedBackend(context: Context): String? = Credentials.load(context.applicationContext)?.backend

    /** Stops the connection and forgets the credentials; the device has to pair again. */
    public fun unpair(context: Context) {
        RelayService.stop(context)
        Credentials.clear(context.applicationContext)
        changed()
    }

    /** The name a device pairs under unless the host gives one: manufacturer and model. */
    public fun defaultDeviceName(): String = "${Build.MANUFACTURER} ${Build.MODEL}"

    // ---- connection ----

    /** Starts (or keeps) the foreground connection. A device that is not paired stays idle. */
    public fun start(context: Context) { RelayService.start(context) }

    /** Stops the connection; the pairing is kept and [start] resumes it. */
    public fun stop(context: Context) { RelayService.stop(context) }

    // ---- state ----

    /** A snapshot: pairing, connection, accessibility and device health. Reads storage; cheap but not free. */
    public fun state(context: Context): AgentState {
        val ctx = context.applicationContext
        val paired = Credentials.load(ctx) != null
        val health = try {
            probeDeviceState(ctx).let { DeviceHealth(it.screenOn, it.keyguardLocked, it.battery, it.charging, it.networkOk) }
        } catch (e: RuntimeException) {
            null
        }
        return AgentState(paired, connection, statusText, StreamAccessibilityService.instance != null, health)
    }

    /**
     * Calls [listener] with the current [state] now and again whenever the connection status,
     * the pairing or the accessibility service changes, until the returned handle is closed.
     * Calls arrive on whichever thread made the change; post to the main thread to touch views.
     */
    public fun observe(context: Context, listener: AgentStateListener): AutoCloseable {
        val ctx = context.applicationContext
        appContext = ctx
        listeners += listener
        deliver(listener, state(ctx))
        return AutoCloseable { listeners -= listener }
    }

    // ---- hooks (experimental) ----

    /** The default indicator provider: the takeover banner. */
    public val defaultIndicator: IndicatorProvider = IndicatorProvider { service, onStop -> Overlay(service, onStop) }

    /**
     * Builds the indicator shown while the agent drives the screen. The default is the takeover
     * banner. A replacement takes effect the next time the agent shows its indicator (the current
     * one is disposed). Build it with [overlayIndicator] so it is attached as an accessibility
     * overlay: the agent ignores those windows when it judges screen changes, and its gestures and
     * screenshots know how to get past it (see [AgentIndicator.passThrough],
     * [AgentIndicator.hideForCapture] and [AgentIndicator.bounds]).
     */
    @Volatile public var indicatorProvider: IndicatorProvider = defaultIndicator

    /**
     * Asked before the agent takes over an app — `focusApp`, `scopeWindow` and every action op —
     * about the target app and about the app in front (which may be the host app itself). A `true`
     * fails the op as `app-in-use` naming that app, exactly like the agent's own refusal; `false`
     * or `null` leaves the decision to the agent's own check. Called on the agent's worker thread;
     * keep it quick. A hint that throws counts as no opinion.
     */
    @Volatile public var occupancyHint: OccupancyHint? = null

    /**
     * Occupancy policy. Off (the default): an app counts as in use when it is the one the op would
     * take over, it is in front, and the user touched the screen in the last 10 seconds. On: any app
     * in front that the user touched in the last 10 seconds counts as in use, whatever the op targets.
     */
    @Volatile public var anyRecentTouchOccupies: Boolean = false

    /** Told after the user stopped the agent from its indicator (the agent has already sent its abort). */
    @Volatile public var userStopListener: UserStopListener? = null

    /**
     * An indicator for [IndicatorProvider.create] that shows the host's own [view] as a
     * `TYPE_ACCESSIBILITY_OVERLAY` window through the agent's accessibility [service], with the
     * library's handling of touch pass-through, screenshot hiding, bounds and the 60 s auto-hide.
     */
    public fun overlayIndicator(service: AccessibilityService, onStop: () -> Unit, view: IndicatorView): AgentIndicator =
        Overlay(service, onStop, view)

    /** The user stopped the agent from its indicator: abort first, then tell the host. */
    internal fun userStopped(abort: () -> Unit) = stopFromIndicator(abort, userStopListener)

    // ---- internal plumbing ----

    private val http = OkHttpClient()
    private val listeners = CopyOnWriteArrayList<AgentStateListener>()
    @Volatile private var appContext: Context? = null

    /** The connection's latest status line, as the relay service last published it. */
    @Volatile internal var statusText: String = "未连接"
        private set
    @Volatile internal var connection: AgentConnection = AgentConnection.IDLE
        private set

    internal fun publish(text: String, phase: AgentConnection) {
        statusText = text
        connection = phase
        changed()
    }

    internal fun setConnection(phase: AgentConnection) {
        connection = phase
        changed()
    }

    /** Something a listener can see changed: tell them. */
    internal fun changed() {
        if (listeners.isEmpty()) return
        val ctx = appContext ?: return
        val s = state(ctx)
        listeners.forEach { deliver(it, s) }
    }

    private fun deliver(l: AgentStateListener, s: AgentState) {
        try {
            l.onState(s)
        } catch (e: RuntimeException) {
            Log.w("Stream", "state listener failed", e)
        }
    }
}

/** Where the connection to the backend stands. */
public enum class AgentConnection {
    /** Not started, or stopped. */
    IDLE,
    CONNECTING,
    CONNECTED,
    /** Lost; a reconnect is scheduled with backoff. */
    RECONNECTING,
    /** The backend removed this device; it has to pair again. */
    REVOKED,
    /** The OS refused to start the foreground service from the background; opening the app recovers. */
    START_REFUSED,
}

/** What the agent last measured about the device. */
public data class DeviceHealth(
    public val screenOn: Boolean,
    public val keyguardLocked: Boolean,
    /** Percent, or -1 when unknown. */
    public val battery: Int,
    public val charging: Boolean,
    /** Whether the OS has validated reachability on the default network. */
    public val networkOk: Boolean,
)

public data class AgentState(
    public val paired: Boolean,
    public val connection: AgentConnection,
    /** The connection's latest status line, e.g. `已连接 http://…`. */
    public val statusText: String,
    /** Whether the user has enabled the agent's accessibility service. */
    public val accessibilityEnabled: Boolean,
    /** Null when it could not be read. */
    public val health: DeviceHealth?,
) {
    /** [statusText] as a status line should show it: once unpaired, a stale connection status reads as unpaired. */
    public val displayStatus: String get() = shownStatus(statusText, paired)
}

public fun interface AgentStateListener {
    public fun onState(state: AgentState)
}

/** What the user sees while the agent drives the screen, with a way to stop it. */
public interface AgentIndicator {
    /** Show [text] as the current step; null hides the indicator. Any thread. */
    public fun show(text: String?)

    /** Let the agent's injected gestures pass through the indicator. Called from the agent's worker
     *  thread right before and after a gesture; return once the change is in effect. */
    public fun passThrough(on: Boolean)

    /**
     * Called from the agent's worker thread right before a screenshot (`hidden = true`) and right
     * after it (`false`, always, even when the capture failed). Return `true` once the indicator is
     * off the screen; the default `false` makes the agent blank [bounds] in the frame instead. An
     * indicator that does neither shows up in screenshots.
     */
    public fun hideForCapture(hidden: Boolean): Boolean = false

    /** Where the indicator is on the screen right now, in screen pixels; null when it is not shown. Any thread. */
    public fun bounds(): IndicatorBounds? = null

    /** Remove the indicator for good. */
    public fun dispose()
}

/** A screen rectangle, in pixels. */
public data class IndicatorBounds(public val left: Int, public val top: Int, public val width: Int, public val height: Int)

/** The host's own indicator content, which [StreamAgent.overlayIndicator] attaches as an accessibility overlay. */
public interface IndicatorView {
    /** Build the view (main thread). Call [onStop] when the user asks to stop the agent. */
    public fun create(context: Context, onStop: () -> Unit): View

    /** Show [text] as the current step on a view [create] built (main thread). */
    public fun bind(view: View, text: String)

    /** The overlay window's gravity, width and height (`WindowManager.LayoutParams` values). */
    public val gravity: Int get() = Gravity.TOP
    public val width: Int get() = WindowManager.LayoutParams.MATCH_PARENT
    public val height: Int get() = WindowManager.LayoutParams.WRAP_CONTENT
}

public fun interface IndicatorProvider {
    /** An indicator drawn through the agent's accessibility [service]; call [onStop] when the user stops the agent. */
    public fun create(service: AccessibilityService, onStop: () -> Unit): AgentIndicator
}

public fun interface OccupancyHint {
    /** Whether the user is busy with [packageName] right now; null = no opinion. See [StreamAgent.occupancyHint]. */
    public fun inUse(packageName: String): Boolean?
}

public fun interface UserStopListener {
    public fun onUserStop()
}
