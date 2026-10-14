package com.streamapp.android.a11y

import android.app.Activity
import android.app.KeyguardManager
import android.os.Bundle

/** Shown for a moment to turn the screen on and dismiss a **non-secure** keyguard. The manifest
 *  sets showWhenLocked + turnScreenOn; `requestDismissKeyguard` needs an Activity. */
class WakeActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        getSystemService(KeyguardManager::class.java).requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
            override fun onDismissSucceeded() = finish()
            override fun onDismissError() = finish()
            override fun onDismissCancelled() = finish()
        })
    }
}
