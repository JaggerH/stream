package com.streamapp.android.a11y

import android.app.Activity
import android.app.KeyguardManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock

/** Shown for a moment to turn the screen on and dismiss a **non-secure** keyguard. The manifest
 *  sets showWhenLocked + turnScreenOn; `requestDismissKeyguard` needs an Activity. */
class WakeActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        createdAt = SystemClock.uptimeMillis()
        // Safety net: never linger if the keyguard callbacks do not fire.
        Handler(Looper.getMainLooper()).postDelayed({ if (!isFinishing) finish() }, 3_000)
        getSystemService(KeyguardManager::class.java).requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
            override fun onDismissSucceeded() = finish()
            override fun onDismissError() = finish()
            override fun onDismissCancelled() = finish()
        })
    }

    // singleInstance: a launch while it is still alive arrives here, not in onCreate.
    override fun onNewIntent(intent: android.content.Intent?) {
        super.onNewIntent(intent)
        createdAt = SystemClock.uptimeMillis()
    }

    companion object {
        /** `uptimeMillis` of the latest creation; lets the waker tell whether the OS let it start. */
        @Volatile var createdAt = 0L
    }
}
