package com.streamapp.android.a11y

import android.accessibilityservice.AccessibilityService
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/**
 * The takeover banner (design D6): a `TYPE_ACCESSIBILITY_OVERLAY` strip at the top with the
 * current status text and a Stop button. Needs no extra permission. It shows on the first
 * non-null status and hides on `status(null)` or after 60 s without a status update.
 */
class Overlay(private val service: AccessibilityService, private val onStop: () -> Unit) {
    private val main = Handler(Looper.getMainLooper())
    private var view: LinearLayout? = null
    private var label: TextView? = null
    private val hide = Runnable { remove() }

    fun show(text: String?) = main.post {
        main.removeCallbacks(hide)
        if (text == null) { remove(); return@post }
        if (view == null) add()
        label?.text = text
        main.postDelayed(hide, 60_000)
    }

    private fun add() {
        val wm = service.getSystemService(WindowManager::class.java)
        val tv = TextView(service).apply { setTextColor(Color.WHITE); textSize = 13f; setPadding(24, 12, 12, 12) }
        val stop = Button(service).apply {
            text = "停止"
            setOnClickListener { onStop(); remove() }
        }
        val bar = LinearLayout(service).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(Color.argb(220, 30, 30, 30))
            addView(tv, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            addView(stop)
        }
        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply { gravity = Gravity.TOP }
        wm.addView(bar, lp)
        view = bar
        label = tv
    }

    private fun remove() {
        view?.let { service.getSystemService(WindowManager::class.java).removeView(it) }
        view = null
        label = null
    }
}
