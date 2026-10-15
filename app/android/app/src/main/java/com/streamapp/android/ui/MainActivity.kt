package com.streamapp.android.ui

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.app.KeyguardManager
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.view.Window
import android.view.WindowInsets
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import com.google.zxing.integration.android.IntentIntegrator
import com.streamapp.android.a11y.StreamAccessibilityService
import com.streamapp.android.net.Pairing
import com.streamapp.android.net.RelayService
import com.streamapp.android.net.shownStatus
import com.streamapp.android.protocol.PairPayload
import com.streamapp.android.protocol.pairChoices
import com.streamapp.android.store.Credentials
import okhttp3.OkHttpClient
import kotlin.concurrent.thread

class MainActivity : Activity() {
    private lateinit var root: LinearLayout
    private lateinit var status: TextView
    private val http = OkHttpClient()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Android 15 draws apps targeting 35 edge to edge: content runs under the status bar and
        // the title bar, so the top of the page (取消配对) sat hidden behind them and could not be
        // scrolled into view. No title bar (the status line is the page's header), and the page
        // is padded by the system bars and cutout.
        requestWindowFeature(Window.FEATURE_NO_TITLE)
        val pad = dp(16)
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        setContentView(ScrollView(this).apply {
            addView(root)
            setOnApplyWindowInsetsListener { v, insets ->
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                insets
            }
        })
        if (Credentials.load(this) != null) RelayService.start(this)
    }

    override fun onResume() {
        super.onResume()
        RelayService.onStatus = { text ->
            runOnUiThread { if (::status.isInitialized) status.text = shownStatus(text, Credentials.load(this) != null) }
        }
        render()
    }

    override fun onPause() {
        RelayService.onStatus = null
        super.onPause()
    }

    override fun onDestroy() {
        RelayService.onStatus = null
        super.onDestroy()
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun text(s: String, size: Float = 14f) = TextView(this).apply {
        text = s
        textSize = size
        setPadding(0, dp(4), 0, dp(4))
    }

    private fun button(label: String, onClick: () -> Unit) = Button(this).apply {
        text = label
        setOnClickListener { onClick() }
    }

    private fun render() {
        root.removeAllViews()
        status = text(shownStatus(RelayService.statusText, Credentials.load(this) != null), 18f)
        root.addView(status)

        val creds = Credentials.load(this)
        if (creds == null) {
            root.addView(button("扫码配对") { scan() })
            root.addView(button("手动输入") { manualDialog() })
        } else {
            root.addView(text("已配对：${creds.backend}"))
            root.addView(button("取消配对") {
                RelayService.stop(this)
                Credentials.clear(this)
                render()
            })
        }

        root.addView(text("设置清单", 18f).apply { setPadding(0, dp(20), 0, dp(4)) })
        checklist()
    }

    // ---- pairing ----

    private fun scan() {
        IntentIntegrator(this)
            .setPrompt("扫描电脑上 Stream 设置 → 手机 里的二维码")
            .setBeepEnabled(false)
            .setOrientationLocked(true)
            .initiateScan()
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        val r = IntentIntegrator.parseActivityResult(requestCode, resultCode, data)
        if (r == null) {
            @Suppress("DEPRECATION")
            super.onActivityResult(requestCode, resultCode, data)
            return
        }
        val contents = r.contents ?: return
        val p = PairPayload.parse(contents)
        if (p == null) toast("这不是 Stream 的配对码") else chooseBackend(p)
    }

    /** The QR carries every address the computer has (LAN, Tailscale…). One: pair with it. Several:
     *  find out which this phone can reach right now, then let the user pick. */
    private fun chooseBackend(p: PairPayload) {
        if (p.backends.size == 1) { doPair(p.backends[0], p.code); return }
        toast("正在检查哪个地址连得上…")
        thread(name = "pair-probe") {
            val reachable = java.util.concurrent.ConcurrentHashMap<String, Boolean>()
            p.backends.map { b -> thread { reachable[b] = Pairing.reachable(b, http) } }.forEach { it.join(3_000) }
            val choices = pairChoices(p.backends, reachable)
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                AlertDialog.Builder(this)
                    .setTitle("用哪个地址连电脑？")
                    .setItems(choices.map { it.label }.toTypedArray()) { _, i -> doPair(choices[i].backend, p.code) }
                    .setNegativeButton("取消", null)
                    .show()
            }
        }
    }

    private fun manualDialog() {
        val pad = dp(16)
        val address = EditText(this).apply { hint = "电脑地址，如 192.168.1.5:8800"; inputType = InputType.TYPE_TEXT_VARIATION_URI or InputType.TYPE_CLASS_TEXT }
        val code = EditText(this).apply { hint = "6 位配对码"; inputType = InputType.TYPE_CLASS_NUMBER }
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, 0)
            addView(address)
            addView(code)
        }
        AlertDialog.Builder(this)
            .setTitle("手动输入")
            .setView(box)
            .setNegativeButton("取消", null)
            .setPositiveButton("配对") { _, _ ->
                val p = PairPayload.manual(address.text.toString(), code.text.toString())
                if (p == null) toast("地址或配对码格式不对") else doPair(p.backends[0], p.code)
            }
            .show()
    }

    /** A pairing request in flight. The code is single-use and five failures void it, so a second
     *  tap must not send it again: that would fail, and count as a failure, right after a success. */
    private var pairing = false

    private fun doPair(backend: String, code: String) {
        if (pairing) return
        pairing = true
        toast("正在配对…")
        thread(name = "pairing") {
            val result = Pairing.pair(backend, code, "${Build.MANUFACTURER} ${Build.MODEL}", http)
            runOnUiThread {
                pairing = false
                if (isFinishing || isDestroyed) return@runOnUiThread
                result.onSuccess { c ->
                    Credentials.save(this, c)
                    RelayService.start(this)
                    render()
                }.onFailure { toast(it.message ?: "配对失败") }
            }
        }
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_LONG).show()

    // ---- setup checklist ----

    private fun checklist() {
        val xiaomi = Build.MANUFACTURER.equals("Xiaomi", ignoreCase = true)
        val a11yOn = StreamAccessibilityService.instance != null

        row("无障碍服务", a11yOn, null, "打开") { open(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
        if (!a11yOn) {
            root.addView(text("如果无障碍里 Stream 是灰的点不动：到 应用信息 → 右上角 ⋮ → 允许受限制的设置，再回来打开", 12f))
        }
        if (Build.VERSION.SDK_INT >= 33) {
            val granted = checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
            row("通知权限", granted, null, "授权") {
                requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
            }
        }
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        row("电池不受限制", pm.isIgnoringBatteryOptimizations(packageName), null, "设置") {
            open(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
        }
        if (xiaomi) {
            row("自启动", null, null, "设置") {
                open(Intent().setComponent(ComponentName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity")))
            }
        }
        row("最近任务里锁定", null, "在最近任务里下拉 Stream 卡片加锁，防止被一键清理", null) {}
        if (xiaomi) {
            row("后台弹出界面 / 锁屏显示", null, "HyperOS 默认不让后台应用弹出界面，Stream 唤醒屏幕和打开外卖 App 都要用到", "设置") {
                open(Intent().setComponent(ComponentName("com.miui.securitycenter", "com.miui.permcenter.permissions.PermissionsEditorActivity"))
                    .putExtra("extra_pkgname", packageName))
            }
        }
        val km = getSystemService(KEYGUARD_SERVICE) as KeyguardManager
        val secure = km.isDeviceSecure
        row("锁屏", !secure, if (secure) "有锁屏密码时 Stream 无法在无人时操作手机" else null, "设置") {
            open(Intent(Settings.ACTION_SECURITY_SETTINGS))
        }
    }

    /** state null = cannot be known; button null = text-only row. */
    private fun row(label: String, state: Boolean?, hint: String?, btnLabel: String?, onClick: () -> Unit) {
        val mark = when (state) { true -> "✓"; false -> "✗"; null -> "?" }
        root.addView(text("$mark  $label", 16f).apply { setPadding(0, dp(12), 0, 0) })
        if (hint != null) root.addView(text(hint, 12f))
        if (btnLabel != null) root.addView(button(btnLabel, onClick))
    }

    /** Open a settings page; any device that lacks it lands on this app's info page instead. */
    private fun open(intent: Intent) {
        try {
            startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            fallbackToAppDetails()
        } catch (_: SecurityException) {
            fallbackToAppDetails()
        }
    }

    private fun fallbackToAppDetails() {
        try {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
        } catch (_: ActivityNotFoundException) {
            toast("打不开设置页")
        }
    }
}
