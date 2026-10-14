package com.streamapp.android

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.streamapp.android.net.RelayService
import com.streamapp.android.store.Credentials

/** Reconnect after a reboot. A phone that is not paired stays idle. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED && Credentials.load(ctx) != null) RelayService.start(ctx)
    }
}
