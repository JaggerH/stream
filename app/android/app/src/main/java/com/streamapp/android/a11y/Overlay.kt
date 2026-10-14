package com.streamapp.android.a11y

import android.accessibilityservice.AccessibilityService
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The takeover banner (design D6): a `TYPE_ACCESSIBILITY_OVERLAY` strip at the top with the
 * current status text and a Stop button. Needs no extra permission. It shows on the first
 * non-null status and hides on `status(null)` or after 60 s without a status update.
 * Window-manager calls can throw (service dying, token gone); they are logged, never propagated.
 */
class Overlay(private val service: AccessibilityService, private val onStop: () -> Unit) {
    private val main = Handler(Looper.getMainLooper())
    private var view: LinearLayout? = null
    private var label: TextView? = null
    private var params: WindowManager.LayoutParams? = null
    private val hide = Runnable { remove() }

    fun show(text: String?) { main.post {
        main.removeCallbacks(hide)
        if (text == null) { remove(); return@post }
        if (view == null) add()
        label?.text = text
        if (view != null) main.postDelayed(hide, 60_000)
    } }

    /** Let injected gestures reach the app under the banner. Waits for the change to apply when
     *  called off the main thread (the worker), so the gesture that follows sees it. */
    fun passThrough(on: Boolean) {
        val apply = Runnable {
            val v = view ?: return@Runnable
            val lp = params ?: return@Runnable
            lp.flags = if (on) lp.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
            else lp.flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE.inv()
            try {
                service.getSystemService(WindowManager::class.java).updateViewLayout(v, lp)
            } catch (e: RuntimeException) {
                Log.w("Stream", "banner updateViewLayout failed", e)
            }
        }
        if (Looper.myLooper() === Looper.getMainLooper()) { apply.run(); return }
        // updateViewLayout only schedules a relayout; the new touchable region reaches the input
        // system a frame or two later. Release the worker after two frames plus a margin, so the
        // injected tap does not land on the banner before the flag takes effect.
        val done = CountDownLatch(1)
        main.post {
            try { apply.run() } catch (e: RuntimeException) { done.countDown(); return@post }
            val choreographer = android.view.Choreographer.getInstance()
            choreographer.postFrameCallback {
                choreographer.postFrameCallback { main.postDelayed({ done.countDown() }, 32) }
            }
        }
        done.await(500, TimeUnit.MILLISECONDS)
    }

    /** Drop pending hides and the banner; the instance is not used afterwards. */
    fun dispose() { main.post { main.removeCallbacks(hide); remove() } }

    private fun add() {
        val wm = service.getSystemService(WindowManager::class.java)
        val tv = TextView(service).apply { setTextColor(Color.WHITE); textSize = 12f; setPadding(24, 4, 12, 4) }
        val stop = Button(service).apply {
            text = "停止"
            minHeight = 0
            minimumHeight = 0
            setPadding(24, 4, 24, 4)
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
        try {
            wm.addView(bar, lp)
        } catch (e: RuntimeException) {
            Log.w("Stream", "banner addView failed", e)
            return
        }
        view = bar
        label = tv
        params = lp
    }

    private fun remove() {
        val v = view
        if (v != null && v.isAttachedToWindow) {
            try {
                service.getSystemService(WindowManager::class.java).removeViewImmediate(v)
            } catch (e: RuntimeException) {
                Log.w("Stream", "banner removeView failed", e)
            }
        }
        view = null
        label = null
        params = null
    }
}
