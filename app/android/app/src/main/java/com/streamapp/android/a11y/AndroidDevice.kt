package com.streamapp.android.a11y

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Path
import android.os.PowerManager
import android.view.Display
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import com.streamapp.android.agent.*
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * `Device` over the live accessibility service. Ops arrive on the relay's worker thread; the
 * gesture and screenshot callbacks are awaited with latches.
 */
class AndroidDevice(private val ctx: Context, private val onStop: () -> Unit) : Device {
    private var overlay: Overlay? = null
    private var overlayFor: StreamAccessibilityService? = null
    private var lastShotAt = 0L
    private var wake: PowerManager.WakeLock? = null

    private fun svc(): StreamAccessibilityService =
        StreamAccessibilityService.instance ?: throw AgentError("a11y-off: 无障碍服务没开，到手机的 设置 → 无障碍 → Stream 打开")

    /** The live `AccessibilityNodeInfo` behind a node this device handed out. */
    private fun infoOf(node: UiNode): AccessibilityNodeInfo = when (node) {
        is AndroidNode -> node.info
        is HintlessNode -> node.inner.info
        else -> throw AgentError("action-failed: 不是这台设备给出的节点")
    }

    override fun ensureAwake() {
        val km = ctx.getSystemService(KeyguardManager::class.java)
        val pm = ctx.getSystemService(PowerManager::class.java)
        if (km.isKeyguardLocked && km.isDeviceSecure) throw AgentError("device-locked: 锁屏有密码，Stream 解不开；这台手机要去掉锁屏密码才能无人值守")
        val lock = wake ?: run {
            @Suppress("DEPRECATION")
            pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP, "stream:op")
                .also { it.setReferenceCounted(false); wake = it }
        }
        // Held for 2 minutes after the latest op, then the screen may sleep again.
        lock.acquire(120_000)
        if (!pm.isInteractive || km.isKeyguardLocked) {
            val before = WakeActivity.createdAt
            ctx.startActivity(Intent(ctx, WakeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            val started = waitFor(1_500) { WakeActivity.createdAt != before }
            if (!started && km.isKeyguardLocked) {
                // The OS may have refused the background activity; a non-secure keyguard also yields to a swipe.
                val s = screenSize()
                try {
                    swipe(s.w / 2, s.h * 85 / 100, s.w / 2, s.h * 35 / 100, 300)
                } catch (e: AgentError) { /* judged by the keyguard state below */ }
            }
            waitFor(if (started) 3_000 else 1_500) { !km.isKeyguardLocked && pm.isInteractive }
            if (km.isKeyguardLocked) {
                if (!started && WakeActivity.createdAt == before) {
                    throw AgentError("blocked-by-os: 系统拦住了 Stream 从后台弹出界面，解不开锁屏。到 设置 → 应用 → Stream → 其他权限，打开「后台弹出界面」和「锁屏显示」")
                }
                throw AgentError("device-locked: 锁屏没能解开")
            }
            if (!pm.isInteractive) throw AgentError("device-locked: 屏幕没能点亮")
        }
    }

    private fun waitFor(ms: Long, cond: () -> Boolean): Boolean {
        val end = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < end) {
            if (cond()) return true
            Thread.sleep(50)
        }
        return cond()
    }

    override fun windows(): List<WindowInfo> = svc().windows
        .filter { it.type != AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY }
        .mapNotNull { w ->
            val root = w.root ?: return@mapNotNull null
            val pkg = root.packageName?.toString() ?: return@mapNotNull null
            if (pkg == ctx.packageName) return@mapNotNull null
            WindowInfo(w.id.toString(), pkg, w.title?.toString() ?: pkg, w.isFocused || w.isActive)
        }

    override fun windowBounds(windowId: String): Rect? =
        svc().windows.firstOrNull { it.id.toString() == windowId }?.let { w ->
            val r = android.graphics.Rect().also { w.getBoundsInScreen(it) }
            Rect(r.left, r.top, r.width(), r.height())
        }

    override fun windowRoot(windowId: String): UiNode? =
        svc().windows.firstOrNull { it.id.toString() == windowId }?.root?.let { AndroidNode.snapshot(it) }

    override fun foregroundPackage(): String? = svc().rootInActiveWindow?.packageName?.toString()

    override fun foregroundComponent(): String = svc().lastComponent.ifEmpty { foregroundPackage() ?: "" }

    override fun launch(packageName: String): Boolean {
        val i = ctx.packageManager.getLaunchIntentForPackage(packageName)
            ?: throw AgentError("no-window-match: 手机上没装 $packageName")
        ctx.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED))
        return true
    }

    /** Click the node, or its nearest clickable ancestor: list rows often put the listener on a parent. */
    override fun click(node: UiNode): Boolean {
        var n: AccessibilityNodeInfo? = infoOf(node)
        while (n != null) {
            if (n.isClickable) return n.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            n = n.parent
        }
        return false
    }

    override fun setText(node: UiNode, text: String): Boolean {
        val info = infoOf(node)
        val args = android.os.Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) }
        return info.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    }

    override fun focusedInput(): UiNode? {
        val f = svc().findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return null
        // A hint is not a value: `type` appends to the current text, and must not append to "搜索商家".
        val n = AndroidNode(f, emptyList())
        return if (f.isShowingHintText) HintlessNode(n) else n
    }

    override fun imeEnter(node: UiNode): Boolean =
        infoOf(node).performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)

    override fun tap(x: Int, y: Int, longPress: Boolean) =
        gesture(Path().apply { moveTo(x.coerceAtLeast(0).toFloat(), y.coerceAtLeast(0).toFloat()) }, if (longPress) 600 else 60)

    override fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Long) =
        gesture(Path().apply {
            moveTo(x1.coerceAtLeast(0).toFloat(), y1.coerceAtLeast(0).toFloat())
            lineTo(x2.coerceAtLeast(0).toFloat(), y2.coerceAtLeast(0).toFloat())
        }, durationMs)

    private fun gesture(path: Path, durationMs: Long) {
        syncOverlay()
        val done = CountDownLatch(1)
        val ok = AtomicBoolean(false)
        val g = try {
            GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, durationMs)).build()
        } catch (e: IllegalArgumentException) {
            throw AgentError("gesture-failed: 手势参数不合法（${e.message}）")
        }
        // The banner would swallow a tap that lands under it.
        overlay?.passThrough(true)
        try {
            val sent = svc().dispatchGesture(g, object : AccessibilityService.GestureResultCallback() {
                override fun onCompleted(d: GestureDescription) { ok.set(true); done.countDown() }
                override fun onCancelled(d: GestureDescription) { done.countDown() }
            }, null)
            if (!sent || !done.await(durationMs + 3_000, TimeUnit.MILLISECONDS) || !ok.get()) {
                throw AgentError("gesture-failed: 系统没执行这次手势（被别的手势打断，或无障碍服务失去了手势权限）")
            }
        } finally {
            overlay?.passThrough(false)
        }
    }

    /** Drop the banner when the service it was built on is gone or replaced. */
    private fun syncOverlay() {
        if (StreamAccessibilityService.instance !== overlayFor) {
            overlay?.dispose()
            overlay = null
            overlayFor = null
        }
    }

    override fun globalBack(): Boolean = svc().performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
    override fun globalHome(): Boolean = svc().performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)

    /** `takeScreenshot` allows about one call per second; calls are spaced 1.1 s apart rather than failed. */
    override fun screenshot(): Shot {
        val wait = lastShotAt + 1_100 - System.currentTimeMillis()
        if (wait > 0) Thread.sleep(wait)
        val done = CountDownLatch(1)
        val out = AtomicReference<Any>()
        val abandoned = AtomicBoolean(false)
        svc().takeScreenshot(Display.DEFAULT_DISPLAY, ctx.mainExecutor, object : AccessibilityService.TakeScreenshotCallback {
            override fun onSuccess(s: AccessibilityService.ScreenshotResult) {
                if (abandoned.get()) { s.hardwareBuffer.close(); return }
                out.set(s); done.countDown()
                // The waiter may have given up between the check and the set.
                if (abandoned.get() && out.getAndSet(null) != null) s.hardwareBuffer.close()
            }
            override fun onFailure(code: Int) { out.set(code); done.countDown() }
        })
        lastShotAt = System.currentTimeMillis()
        if (!done.await(5, TimeUnit.SECONDS)) {
            abandoned.set(true)
            (out.getAndSet(null) as? AccessibilityService.ScreenshotResult)?.hardwareBuffer?.close()
            throw AgentError("gesture-failed: 截图超时")
        }
        val r = out.get()
        if (r is Int) {
            if (r == AccessibilityService.ERROR_TAKE_SCREENSHOT_SECURE_WINDOW) throw AgentError("secure-window: 当前画面禁止截图（支付、密码页）")
            throw AgentError("gesture-failed: 截图失败，系统错误码 $r")
        }
        val shot = r as AccessibilityService.ScreenshotResult
        val buffer = shot.hardwareBuffer
        var hw: Bitmap? = null
        var bmp: Bitmap? = null
        try {
            hw = Bitmap.wrapHardwareBuffer(buffer, shot.colorSpace)
                ?: throw AgentError("gesture-failed: 截图缓冲读不出来")
            bmp = hw.copy(Bitmap.Config.ARGB_8888, false)
                ?: throw AgentError("gesture-failed: 截图缓冲读不出来")
            if (isAllBlack(bmp)) throw AgentError("secure-window: 画面是全黑的，当前页面禁止截图（支付、密码页）或屏幕没亮")
            val bytes = ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.JPEG, 80, it) }.toByteArray()
            return Shot(bytes, Rect(0, 0, bmp.width, bmp.height), ctx.resources.displayMetrics.density.toDouble())
        } finally {
            buffer.close()
            hw?.recycle()
            bmp?.recycle()
        }
    }

    /** A secure window comes back as a black frame rather than an error on some ROMs. */
    private fun isAllBlack(bmp: Bitmap): Boolean {
        for (iy in 0 until 16) for (ix in 0 until 16) {
            val p = bmp.getPixel((ix * (bmp.width - 1)) / 15, (iy * (bmp.height - 1)) / 15)
            if (android.graphics.Color.red(p) > 8 || android.graphics.Color.green(p) > 8 || android.graphics.Color.blue(p) > 8) return false
        }
        return true
    }

    override fun screenSize(): Rect = ctx.resources.displayMetrics.let { Rect(0, 0, it.widthPixels, it.heightPixels) }

    override fun status(text: String?) {
        syncOverlay()
        val s = StreamAccessibilityService.instance ?: return
        if (overlayFor !== s) { overlay = Overlay(s, onStop); overlayFor = s }
        overlay?.show(text)
    }

    override fun sleep(ms: Long) = Thread.sleep(ms.coerceIn(0, 30_000))
}
