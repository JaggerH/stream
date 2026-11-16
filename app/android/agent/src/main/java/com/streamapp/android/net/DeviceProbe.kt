package com.streamapp.android.net

import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.PowerManager
import com.streamapp.android.a11y.StreamAccessibilityService
import com.streamapp.android.protocol.DeviceState

/** The device facts the `state` frame reports (and `StreamAgent.state` exposes as health). */
internal fun probeDeviceState(ctx: Context): DeviceState {
    val pm = ctx.getSystemService(PowerManager::class.java)
    val km = ctx.getSystemService(KeyguardManager::class.java)
    val bat = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
    val level = bat?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
    val scale = bat?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
    val plugged = (bat?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0) != 0
    val cm = ctx.getSystemService(ConnectivityManager::class.java)
    val caps = cm.activeNetwork?.let { cm.getNetworkCapabilities(it) }
    return DeviceState(
        a11yEnabled = StreamAccessibilityService.instance != null,
        screenOn = pm.isInteractive,
        keyguardLocked = km.isKeyguardLocked,
        battery = if (level < 0) -1 else level * 100 / scale,
        charging = plugged,
        networkOk = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true,
    )
}
