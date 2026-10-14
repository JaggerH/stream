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
        if (wake?.isHeld != true) {
            @Suppress("DEPRECATION")
            wake = pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP, "stream:op")
        }
        // Held for 2 minutes after the latest op, then the screen may sleep again.
        wake?.acquire(120_000)
        if (!pm.isInteractive || km.isKeyguardLocked) {
            ctx.startActivity(Intent(ctx, WakeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            val deadline = System.currentTimeMillis() + 3_000
            while ((km.isKeyguardLocked || !pm.isInteractive) && System.currentTimeMillis() < deadline) Thread.sleep(100)
            if (km.isKeyguardLocked) throw AgentError("device-locked: 锁屏没能解开")
        }
    }

    override fun windows(): List<WindowInfo> = svc().windows
        .filter { it.type != AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY }
        .mapNotNull { w ->
            val root = w.root ?: return@mapNotNull null
            val pkg = root.packageName?.toString() ?: return@mapNotNull null
            WindowInfo(w.id.toString(), pkg, w.title?.toString() ?: pkg, w.isActive)
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
        gesture(Path().apply { moveTo(x.toFloat(), y.toFloat()) }, if (longPress) 600 else 60)

    override fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Long) =
        gesture(Path().apply { moveTo(x1.toFloat(), y1.toFloat()); lineTo(x2.toFloat(), y2.toFloat()) }, durationMs)

    private fun gesture(path: Path, durationMs: Long) {
        val done = CountDownLatch(1)
        val ok = AtomicBoolean(false)
        val g = GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, durationMs)).build()
        val sent = svc().dispatchGesture(g, object : AccessibilityService.GestureResultCallback() {
            override fun onCompleted(d: GestureDescription) { ok.set(true); done.countDown() }
            override fun onCancelled(d: GestureDescription) { done.countDown() }
        }, null)
        if (!sent || !done.await(durationMs + 3_000, TimeUnit.MILLISECONDS) || !ok.get()) {
            throw AgentError("gesture-failed: 系统没执行这次手势（被别的手势打断，或无障碍服务失去了手势权限）")
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
        svc().takeScreenshot(Display.DEFAULT_DISPLAY, ctx.mainExecutor, object : AccessibilityService.TakeScreenshotCallback {
            override fun onSuccess(s: AccessibilityService.ScreenshotResult) { out.set(s); done.countDown() }
            override fun onFailure(code: Int) { out.set(code); done.countDown() }
        })
        lastShotAt = System.currentTimeMillis()
        if (!done.await(5, TimeUnit.SECONDS)) throw AgentError("gesture-failed: 截图超时")
        val r = out.get()
        if (r is Int) {
            if (r == AccessibilityService.ERROR_TAKE_SCREENSHOT_SECURE_WINDOW) throw AgentError("secure-window: 当前画面禁止截图（支付、密码页）")
            throw AgentError("gesture-failed: 截图失败，系统错误码 $r")
        }
        val shot = r as AccessibilityService.ScreenshotResult
        val hw = Bitmap.wrapHardwareBuffer(shot.hardwareBuffer, shot.colorSpace)
            ?: throw AgentError("gesture-failed: 截图缓冲读不出来")
        val bmp = hw.copy(Bitmap.Config.ARGB_8888, false)
        shot.hardwareBuffer.close()
        val bytes = ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.JPEG, 80, it) }.toByteArray()
        return Shot(bytes, Rect(0, 0, bmp.width, bmp.height), ctx.resources.displayMetrics.density.toDouble())
    }

    override fun screenSize(): Rect = ctx.resources.displayMetrics.let { Rect(0, 0, it.widthPixels, it.heightPixels) }

    override fun status(text: String?) {
        val s = StreamAccessibilityService.instance ?: return
        if (overlayFor !== s) { overlay = Overlay(s, onStop); overlayFor = s }
        overlay?.show(text)
    }

    override fun sleep(ms: Long) = Thread.sleep(ms.coerceIn(0, 30_000))
}
