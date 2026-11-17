package com.streamapp.android.a11y

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.view.WindowManager
import android.view.MotionEvent
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.streamapp.android.AgentIndicator
import com.streamapp.android.IndicatorBounds
import com.streamapp.android.IndicatorView
import com.streamapp.android.agentlib.R
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * An indicator window (design D6): a `TYPE_ACCESSIBILITY_OVERLAY` showing [content] — by default
 * the takeover banner, a strip at the top with the current status text and a Stop button. Needs no
 * extra permission. It shows on the first non-null status and hides on `status(null)` or after 60 s
 * without a status update. Window-manager calls can throw (service dying, token gone); they are
 * logged, never propagated.
 */
internal class Overlay(
    private val service: AccessibilityService,
    private val onStop: () -> Unit,
    private val content: IndicatorView = Banner,
) : AgentIndicator {
    private val main = Handler(Looper.getMainLooper())
    /** The window's root: [content]'s view inside a frame that notes the user's touches. */
    private var view: View? = null
    /** [content]'s own view, the one [IndicatorView.bind] gets. */
    private var inner: View? = null
    private var params: WindowManager.LayoutParams? = null
    private val hide = Runnable { remove() }
    /** Between `hideForCapture(true)` and `(false)`: a view added meanwhile starts invisible. */
    @Volatile private var capturing = false
    @Volatile private var shownAt: IndicatorBounds? = null
    private val track = View.OnLayoutChangeListener { v, _, _, _, _, _, _, _, _ ->
        val loc = IntArray(2)
        v.getLocationOnScreen(loc)
        shownAt = IndicatorBounds(loc[0], loc[1], v.width, v.height)
    }

    override fun show(text: String?) { main.post {
        main.removeCallbacks(hide)
        if (text == null) { remove(); return@post }
        if (view == null) add()
        inner?.let { content.bind(it, text) }
        if (view != null) main.postDelayed(hide, 60_000)
    } }

    /** Let injected gestures reach the app under the banner. Waits for the change to apply when
     *  called off the main thread (the worker), so the gesture that follows sees it. */
    override fun passThrough(on: Boolean) = onMainThenFrames(settle = true) {
        val v = view ?: return@onMainThenFrames
        val lp = params ?: return@onMainThenFrames
        lp.flags = if (on) lp.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
        else lp.flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE.inv()
        try {
            service.getSystemService(WindowManager::class.java).updateViewLayout(v, lp)
        } catch (e: RuntimeException) {
            Log.w("Stream", "banner updateViewLayout failed", e)
        }
    }

    /** Off the screen for a screenshot: the window stays (no window change, no relayout), its view
     *  draws nothing. Hiding waits for the compositor to drop the frame; restoring does not. */
    override fun hideForCapture(hidden: Boolean): Boolean {
        capturing = hidden
        onMainThenFrames(settle = hidden) { view?.visibility = if (hidden) View.INVISIBLE else View.VISIBLE }
        return true
    }

    override fun bounds(): IndicatorBounds? = shownAt

    /** Drop pending hides and the banner; the instance is not used afterwards. */
    override fun dispose() { main.post { main.removeCallbacks(hide); remove() } }

    /**
     * Runs [change] on the main thread. Off the main thread with [settle], returns only after two
     * frames plus a margin: `updateViewLayout` and a visibility change only schedule work, and the
     * new touchable region or the dropped frame reaches the system a frame or two later.
     */
    private fun onMainThenFrames(settle: Boolean, change: () -> Unit) {
        if (Looper.myLooper() === Looper.getMainLooper()) { change(); return }
        val done = CountDownLatch(1)
        main.post {
            try { change() } catch (e: RuntimeException) { done.countDown(); return@post }
            if (!settle) { done.countDown(); return@post }
            val choreographer = android.view.Choreographer.getInstance()
            choreographer.postFrameCallback {
                choreographer.postFrameCallback { main.postDelayed({ done.countDown() }, 32) }
            }
        }
        done.await(500, TimeUnit.MILLISECONDS)
    }

    private fun add() {
        val wm = service.getSystemService(WindowManager::class.java)
        val built = try {
            content.create(service) { onStop(); remove() }
        } catch (e: RuntimeException) {
            Log.w("Stream", "indicator view failed", e)
            return
        }
        // A touch on the indicator is not the user using the app under it. The frame becomes the
        // window root in place of the host's view, carrying that view's view-tree owners.
        val v = OwnTouchFrame(service, built)
        val lp = WindowManager.LayoutParams(
            content.width, content.height,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply { gravity = content.gravity }
        if (capturing) v.visibility = View.INVISIBLE
        v.addOnLayoutChangeListener(track)
        try {
            wm.addView(v, lp)
        } catch (e: RuntimeException) {
            Log.w("Stream", "banner addView failed", e)
            v.removeOnLayoutChangeListener(track)
            return
        }
        view = v
        inner = built
        params = lp
    }

    private fun remove() {
        val v = view
        if (v != null) {
            v.removeOnLayoutChangeListener(track)
            if (v.isAttachedToWindow) {
                try {
                    service.getSystemService(WindowManager::class.java).removeViewImmediate(v)
                } catch (e: RuntimeException) {
                    Log.w("Stream", "banner removeView failed", e)
                }
            }
        }
        view = null
        inner = null
        params = null
        shownAt = null
    }

    /** The default content: the status text and a Stop button on a dark strip. */
    private object Banner : IndicatorView {
        override fun create(context: Context, onStop: () -> Unit): View {
            val tv = TextView(context).apply { setTextColor(Color.WHITE); textSize = 12f; setPadding(24, 4, 12, 4) }
            val stop = Button(context).apply {
                text = context.getString(R.string.stream_agent_indicator_stop)
                minHeight = 0
                minimumHeight = 0
                setPadding(24, 4, 24, 4)
                setOnClickListener { onStop() }
            }
            return LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                setBackgroundColor(Color.argb(220, 30, 30, 30))
                addView(tv, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
                addView(stop)
                tag = tv
            }
        }

        override fun bind(view: View, text: String) {
            (view.tag as? TextView)?.text = text
        }
    }
}

/**
 * The indicator window's root: a frame around the host's [content] that tells the agent about every
 * touch that starts on it, before passing it on — the agent's own surfaces do not count as the user
 * using the app in front.
 *
 * It takes the window-root place [content] would have had, so it carries [content]'s androidx
 * view-tree owners ([copyViewTreeOwners]): once when built, and again when the window attaches,
 * before [content] attaches — a host may set them on its view after [IndicatorView.create]
 * returned. Without them a Compose [content] cannot find a lifecycle owner from the window root and
 * throws while the window attaches, which takes the whole process (and the accessibility service)
 * down. A touch listener on [content] instead of the frame would leave the root alone, but a
 * view group's own listener only sees touches none of its children took, which for a Compose view
 * is none of them.
 */
internal class OwnTouchFrame(context: Context, private val content: View) : FrameLayout(context) {
    init {
        addView(content, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        copyViewTreeOwners(content, this)
    }

    override fun onAttachedToWindow() {
        // Runs before the children's own onAttachedToWindow (ViewGroup.dispatchAttachedToWindow).
        copyViewTreeOwners(content, this)
        super.onAttachedToWindow()
    }

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        if (ev.actionMasked == MotionEvent.ACTION_DOWN) StreamAccessibilityService.inputs.ownSurfaceTouched(System.currentTimeMillis())
        return super.dispatchTouchEvent(ev)
    }
}
