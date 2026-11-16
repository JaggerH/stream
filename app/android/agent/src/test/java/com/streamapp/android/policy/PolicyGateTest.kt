package com.streamapp.android.policy

import com.streamapp.android.agent.AgentError
import com.streamapp.android.agent.Dispatcher
import com.streamapp.android.agent.FakeDevice
import com.streamapp.android.agent.FakeNode
import com.streamapp.android.agent.Rect
import com.streamapp.android.agent.WindowInfo
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The gate and the approval credential, end to end against a fake device: ask detection and its
 * receipt, the four checks (binding, one-shot, expiry, staleness), busy, deny visibility, both
 * exemption kinds, and the conservative fallback.
 */
class PolicyGateTest {
    private lateinit var dev: FakeDevice
    private lateinit var policy: PolicyContext
    private lateinit var d: Dispatcher

    @Suppress("UNCHECKED_CAST") private fun map(v: Any?) = v as Map<String, Any?>
    private fun call(op: String, args: String = "{}") = d.dispatch(op, JSONObject(args))
    private fun err(op: String, args: String = "{}"): AgentError {
        try {
            call(op, args)
        } catch (e: AgentError) {
            return e
        }
        throw AssertionError("expected AgentError from $op $args")
    }

    private fun errCode(op: String, args: String = "{}") = err(op, args).errorCode

    private fun payScreen(pkg: String = "com.example.shop", title: String = "商店") = FakeNode(
        "FrameLayout", className = "android.widget.FrameLayout", rect = Rect(0, 0, 1080, 2400),
        children = listOf(
            FakeNode("Button", "立即支付", className = "android.widget.Button", rect = Rect(0, 1800, 1080, 120), isClickable = true),
            FakeNode("Button", "取消", className = "android.widget.Button", rect = Rect(0, 1950, 1080, 120), isClickable = true),
            FakeNode("Button", "商品详情", className = "android.widget.Button", rect = Rect(0, 2100, 1080, 120), isClickable = true),
        ),
    )

    private fun single(vararg kids: FakeNode) = FakeNode(
        "FrameLayout", className = "android.widget.FrameLayout", rect = Rect(0, 0, 1080, 2400), children = kids.toList(),
    )

    /** [allowDeny]: scoping a deny-category app fails as app-denied; tests of the deny surface
     *  set up exactly that state and expect the failure. */
    private fun setUpApp(
        pkg: String,
        title: String,
        root: FakeNode = payScreen(pkg, title),
        foreground: Boolean = true,
        freshPolicy: Boolean = true,
    ) {
        dev = FakeDevice()
        dev.wins = mutableListOf(WindowInfo("1", pkg, title, foreground))
        dev.roots["1"] = root
        dev.fg = pkg
        if (freshPolicy || !this::policy.isInitialized) policy = PolicyContext.fromSourceTree("gate-device")
        d = Dispatcher(dev, policy)
        runCatching { call("scopeWindow", """{"match":{"process":"$pkg"}}""") }
    }

    private fun reasons(e: AgentError): List<String> {
        val a = e.semantics!!.getJSONArray("reasons")
        return (0 until a.length()).map { a.getString(it) }
    }

    private fun ref(role: String, y: Int): String {
        @Suppress("UNCHECKED_CAST")
        val els = map(call("find", """{"query":{"role":"$role"}}"""))["elements"] as List<Map<String, Any?>>
        return els.first { (it["rect"] as Map<String, Int>)["y"] == y }["ref"] as String
    }

    /** A credential carrying exactly the digests of the receipt an ask produced. */
    private fun approvalOf(e: AgentError, ttlMs: Long = 60_000): String = JSONObject()
        .put("id", "approval-1")
        .put("bindingDigest", e.semantics!!.getString("bindingDigest"))
        .put("screenDigest", e.semantics.getString("screenDigest"))
        .put("expiresAt", System.currentTimeMillis() + ttlMs)
        .toString()

    // ---- the ask gate ---------------------------------------------------------------

    @Test fun commitButtonIsHeldForApproval() {
        setUpApp("com.example.shop", "商店")
        val e = err("invoke", """{"ref":"${ref("Button", 1800)}"}""")
        assertEquals("approval-required", e.errorCode)
        assertTrue(reasons(e).containsAll(listOf("commit-label", "payment-label")))
        assertFalse(dev.log.any { it.startsWith("click") })
        assertEquals("com.example.shop", e.semantics!!.getJSONObject("app").getString("id"))
        assertEquals("商店", e.semantics!!.getJSONObject("app").getString("name"))
        assertEquals("立即支付", e.semantics!!.getJSONObject("control").getString("label"))
    }

    @Test fun unrecognizedCommitShapeStillGates() {
        setUpApp("com.example.shop", "商店", root = single(
            FakeNode("EditText", "收货地址", className = "android.widget.EditText", rect = Rect(0, 100, 1080, 90), isEditable = true),
            FakeNode("Button", "开始", className = "android.widget.Button", rect = Rect(0, 1800, 1080, 120), isClickable = true),
        ))
        val e = err("invoke", """{"ref":"${ref("Button", 1800)}"}""")
        assertEquals("approval-required", e.errorCode)
        assertTrue(reasons(e).contains("commit-unrecognized"))
    }

    @Test fun cancellationTabsAndDetailButtonsRunFree() {
        setUpApp("com.example.shop", "商店")
        call("invoke", """{"ref":"${ref("Button", 1950)}"}""") // 取消
        call("invoke", """{"ref":"${ref("Button", 2100)}"}""") // 商品详情, a place not an action
        assertEquals(2, dev.log.count { it.startsWith("click") })
        setUpApp("com.example.shop", "商店", root = single(
            FakeNode("Tab", "交易", className = "android.widget.TabWidget", rect = Rect(0, 0, 300, 90), isClickable = true),
        ))
        call("invoke", """{"ref":"${ref("Tab", 0)}"}""")
        assertEquals(1, dev.log.count { it.startsWith("click") })
    }

    @Test fun coordinateClickHitsTheSameGate() {
        setUpApp("com.example.shop", "商店")
        val e = err("click", """{"rect":{"x":0,"y":1860,"w":1080,"h":1}}""")
        assertEquals("approval-required", e.errorCode)
        assertEquals("立即支付", e.semantics!!.getJSONObject("control").getString("label"))
    }

    @Test fun dialogAffirmativeGatesAsDialogConfirm() {
        setUpApp("com.example.shop", "商店", root = single(
            FakeNode("TextView", "删除这条消息吗？", className = "android.widget.TextView", rect = Rect(0, 100, 1080, 60)),
            FakeNode("Button", "确定", className = "android.widget.Button", rect = Rect(0, 300, 200, 90), isClickable = true),
        ))
        assertTrue(reasons(err("invoke", """{"ref":"${ref("Button", 300)}"}""")).contains("dialog-confirm"))
    }

    @Test fun sendInMessagingGatesOnlyOnSubmit() {
        val input = FakeNode("EditText", "", className = "android.widget.EditText", rect = Rect(0, 2200, 900, 90), isEditable = true)
        setUpApp("com.tencent.mm", "微信", root = single(input))
        dev.focused = input
        val e = err("type", """{"text":"你好\n"}""")
        assertEquals("approval-required", e.errorCode)
        assertTrue(reasons(e).contains("message-send"))
        assertFalse(dev.log.any { it.startsWith("setText") })
        // The same message without the newline is an ordinary edit.
        setUpApp("com.tencent.mm", "微信", root = single(input))
        dev.focused = dev.roots["1"]!!.children[0]
        call("type", """{"text":"你好"}""")
        assertTrue("setText =你好" in dev.log)
    }

    @Test fun installAndCallAndSettingDirections() {
        setUpApp("com.android.vending", "Play Store", root = single(
            FakeNode("Button", "Install", className = "android.widget.Button", rect = Rect(0, 300, 300, 90), isClickable = true),
        ))
        assertTrue(reasons(err("invoke", """{"ref":"${ref("Button", 300)}"}""")).contains("install"))

        setUpApp("com.example.dialer", "电话", root = single(
            FakeNode("Button", "呼叫 张三", className = "android.widget.Button", rect = Rect(0, 300, 300, 90), isClickable = true),
        ))
        assertTrue(reasons(err("invoke", """{"ref":"${ref("Button", 300)}"}""")).contains("call"))

        setUpApp("com.android.settings", "设置", root = single(
            FakeNode("Switch", "飞行模式", className = "android.widget.Switch", rect = Rect(0, 300, 300, 90), isClickable = true),
        ))
        assertTrue(reasons(err("invoke", """{"ref":"${ref("Switch", 300)}"}""")).contains("setting"))
    }

    @Test fun sliderScrollGates() {
        setUpApp("com.example.pay", "支付", root = single(
            FakeNode("SeekBar", "Slide to pay", className = "android.widget.SeekBar", rect = Rect(0, 1000, 1080, 90)),
        ))
        assertEquals("approval-required", errCode("scroll", """{"dir":"down","amount":1}"""))
        assertFalse(dev.log.any { it.startsWith("swipe") })
        // A plain scroll on a plain page runs free.
        setUpApp("com.example.shop", "商店")
        call("scroll", """{"dir":"down","amount":1}""")
        assertTrue(dev.log.any { it.startsWith("swipe") })
    }

    // ---- the four checks ------------------------------------------------------------

    @Test fun approvalThenResendExecutesExactlyOnce() {
        setUpApp("com.example.shop", "商店")
        val r = ref("Button", 1800) // the caller replays the same call verbatim: same ref string
        val e = err("invoke", """{"ref":"$r"}""")
        call("invoke", """{"ref":"$r","approval":${approvalOf(e)}}""")
        assertTrue("click 立即支付" in dev.log)
        assertEquals("approval-used", errCode("invoke", """{"ref":"$r","approval":${approvalOf(e)}}"""))
        assertEquals(1, dev.log.count { it.startsWith("click") })
    }

    @Test fun changedArgsOrChangedOpInvalidatesTheBinding() {
        setUpApp("com.example.shop", "商店")
        val r = ref("Button", 1800)
        val e = err("invoke", """{"ref":"$r"}""")
        val r2 = ref("Button", 1950) // a newer find; its ref string differs from the approved one
        // 改参数
        assertEquals("approval-mismatch", errCode("invoke", """{"ref":"$r2","approval":${approvalOf(e)}}"""))
        // 换 op（同一次批准，换成坐标点击重发）
        assertEquals("approval-mismatch", errCode("click", """{"rect":{"x":0,"y":1860,"w":1080,"h":1},"approval":${approvalOf(e)}}"""))
        assertFalse(dev.log.any { it.startsWith("click") || it.startsWith("tap") })
    }

    @Test fun restartRotatesTheLeaseSoOldCredentialsMismatch() {
        setUpApp("com.example.shop", "商店")
        val e = err("invoke", """{"ref":"${ref("Button", 1800)}"}""")
        val approval = approvalOf(e)
        // The process restarted: the device is the same, the lease is not.
        policy = PolicyContext.fromSourceTree("gate-device")
        d = Dispatcher(dev, policy)
        call("scopeWindow", """{"match":{"process":"com.example.shop"}}""")
        assertEquals("approval-mismatch", errCode("invoke", """{"ref":"${ref("Button", 1800)}","approval":$approval}"""))
        assertFalse(dev.log.any { it.startsWith("click") })
    }

    @Test fun expiryKeepsTheBoundary() {
        setUpApp("com.example.shop", "商店")
        val r = ref("Button", 1800)
        val e = err("invoke", """{"ref":"$r"}""")
        assertEquals("approval-expired", errCode("invoke",
            """{"ref":"$r","approval":${approvalOf(e, ttlMs = 0)}}"""))
        // A credential well inside its lifetime is valid, and the expired failure consumed nothing.
        call("invoke", """{"ref":"$r","approval":${approvalOf(e, ttlMs = 60_000)}}""")
        assertTrue("click 立即支付" in dev.log)
    }

    @Test fun screenChangeIsStaleAndFailureConsumesNothing() {
        setUpApp("com.example.shop", "商店")
        val e = err("invoke", """{"ref":"${ref("Button", 1800)}"}""")
        // The page scrolled: content moved.
        setUpApp("com.example.shop", "商店", freshPolicy = false, root = FakeNode(
            "FrameLayout", className = "android.widget.FrameLayout", rect = Rect(0, 0, 1080, 2400),
            children = payScreen().children.map {
                FakeNode(it.role, it.name, className = it.className, text = it.text,
                    rect = Rect(it.rect.x, it.rect.y - 300, it.rect.w, it.rect.h), isClickable = it.isClickable)
            },
        ))
        assertEquals("approval-stale", errCode("invoke", """{"ref":"${ref("Button", 1500)}","approval":${approvalOf(e)}}"""))
        // The same credential still works on the restored screen: the stale failure consumed nothing.
        setUpApp("com.example.shop", "商店", freshPolicy = false)
        call("invoke", """{"ref":"${ref("Button", 1800)}","approval":${approvalOf(e)}}""")
        assertTrue("click 立即支付" in dev.log)
    }

    @Test fun carouselElsewhereDoesNotStaleTheApproval() {
        fun page(bannerTop: Int) = FakeNode(
            "FrameLayout", className = "android.widget.FrameLayout", rect = Rect(0, 0, 1080, 2400),
            children = listOf(
                FakeNode("ViewPager", "轮播", className = "androidx.viewpager.widget.ViewPager", rect = Rect(0, bannerTop, 1080, 400)),
                FakeNode("Button", "立即支付", className = "android.widget.Button", rect = Rect(0, 1800, 1080, 120), isClickable = true),
            ),
        )
        setUpApp("com.example.shop", "商店", root = page(0))
        val e = err("invoke", """{"ref":"${ref("Button", 1800)}"}""")
        setUpApp("com.example.shop", "商店", freshPolicy = false, root = page(320)) // the carousel ticked
        call("invoke", """{"ref":"${ref("Button", 1800)}","approval":${approvalOf(e)}}""")
        assertTrue("click 立即支付" in dev.log)
    }

    // ---- busy -----------------------------------------------------------------------

    @Test fun busyRejectsExecutionOpsAndAnswersObservability() {
        setUpApp("com.example.shop", "商店")
        d.setBusy(true, "等审批")
        assertEquals("device-busy", errCode("click", """{"rect":{"x":0,"y":0,"w":2,"h":2}}"""))
        assertEquals("device-busy", errCode("windows"))
        assertTrue(err("click").message!!.contains("等审批"))
        call("status", """{"text":"busy"}""")
        call("sleep", """{"ms":5}""")
        // Locked beats busy: the keyguard check comes first.
        dev.locked = true
        assertEquals("device-locked", errCode("click", """{"rect":{"x":0,"y":0,"w":2,"h":2}}"""))
        dev.locked = false
        d.setBusy(false, null)
        call("click", """{"rect":{"x":0,"y":0,"w":2,"h":2}}""")
        // A reconnect builds a fresh dispatcher: busy is gone.
        d.setBusy(true, null)
        d = Dispatcher(dev, policy)
        call("scopeWindow", """{"match":{"process":"com.example.shop"}}""")
        call("click", """{"rect":{"x":0,"y":0,"w":2,"h":2}}""")
    }

    // ---- deny visibility ------------------------------------------------------------

    @Test fun denyCategoryIsInvisibleOnEverySurface() {
        setUpApp("com.eg.android.AlipayGphone", "支付宝")
        assertFalse(call("windows").toString().contains("Alipay"))
        assertEquals("app-denied", errCode("scopeWindow", """{"match":{"process":"com.eg.android.AlipayGphone"}}"""))
        assertEquals("app-denied", errCode("find", """{"query":{"role":"Button"}}"""))
        assertEquals("app-denied", errCode("readSubtree",
            """{"spec":{"itemQuery":{"role":"Button"},"fields":{"名":{"read":"name"}}}}"""))
        // Actions, including a coordinate click that would hit the pay button — deny outranks the ask.
        assertEquals("app-denied", errCode("click", """{"rect":{"x":0,"y":1860,"w":1080,"h":1}}"""))
        assertEquals("app-denied", errCode("url"))
        assertEquals("app-denied", errCode("focusApp", """{"match":{"process":"com.eg.android.AlipayGphone"}}"""))
        assertEquals("app-denied", errCode("screenshot"))
    }

    // ---- exemptions -----------------------------------------------------------------

    @Test fun askExemptionFreesItsOwnKindOnly() {
        val input = FakeNode("EditText", "", className = "android.widget.EditText", rect = Rect(0, 2200, 900, 90), isEditable = true)
        setUpApp("com.tencent.mm", "微信", root = single(
            FakeNode("Button", "立即支付", className = "android.widget.Button", rect = Rect(0, 1800, 1080, 120), isClickable = true),
            input,
        ))
        dev.focused = input
        assertEquals("approval-required", errCode("type", """{"text":"你好\n"}"""))
        d.grantExemptions(listOf(AskExemption("com.tencent.mm", "send")), emptyList())
        call("type", """{"text":"你好\n"}""")
        assertTrue("setText =你好\n" in dev.log)
        // Another kind in the same app still asks.
        assertEquals("approval-required", errCode("invoke", """{"ref":"${ref("Button", 1800)}"}"""))
        // Another app's send still asks (a fresh dispatcher: the exemption set is empty again).
        val input2 = FakeNode("EditText", "", className = "android.widget.EditText", rect = Rect(0, 2200, 900, 90), isEditable = true)
        setUpApp("jp.naver.line.android", "LINE", root = single(input2))
        dev.focused = dev.roots["1"]!!.children[0]
        assertEquals("approval-required", errCode("type", """{"text":"hi\n"}"""))
    }

    @Test fun askExemptionDoesNotLiftInvisibility() {
        setUpApp("com.eg.android.AlipayGphone", "支付宝")
        d.grantExemptions(listOf(AskExemption("com.eg.android.AlipayGphone", "commit")), emptyList())
        assertEquals("app-denied", errCode("find", """{"query":{"role":"Button"}}"""))
    }

    @Test fun financeVisibilityExemptionLiftsReadsButNotTheAskGate() {
        setUpApp("com.eg.android.AlipayGphone", "支付宝")
        assertEquals("app-denied", errCode("find", """{"query":{"role":"Button"}}"""))
        d.grantExemptions(emptyList(), listOf("com.eg.android.AlipayGphone"))
        call("scopeWindow", """{"match":{"process":"com.eg.android.AlipayGphone"}}""")
        call("find", """{"query":{"role":"Button"}}""")
        assertTrue(call("windows").toString().contains("Alipay"))
        // The commit still asks, every single time.
        assertEquals("approval-required", errCode("invoke", """{"ref":"${ref("Button", 1800)}"}"""))
        assertEquals("approval-required", errCode("invoke", """{"ref":"${ref("Button", 1800)}"}"""))
        // The caller revokes; invisibility returns.
        d.grantExemptions(emptyList(), emptyList())
        assertEquals("app-denied", errCode("find", """{"query":{"role":"Button"}}"""))
    }

    // ---- custom tables: ask lists, blocked entries ----------------------------------

    @Test fun categoryAskAndBlockedEntriesWork() {
        val words = Words.load { java.io.File("src/main/assets/$it").inputStream() }
        val categories = Categories(JSONObject("""{"categories":{
            "passwords":{"ids":["com.example.wallet"],"names":["钱包"],"deny":true},
            "blocked":{"ids":["com.example.bad"],"names":["坏App"],"deny":true},
            "messaging":{"ids":["com.example.chat"],"names":["聊天"],"deny":false,"ask":["send"]}
        }}"""))
        policy = PolicyContext("gate-device", words, categories)

        // The category's ask list adds app-category-ask on top of the word-table reason.
        setUpApp("com.example.chat", "聊天", freshPolicy = false, root = single(
            FakeNode("EditText", "", className = "android.widget.EditText", rect = Rect(0, 2200, 900, 90), isEditable = true),
        ))
        dev.focused = dev.roots["1"]!!.children[0]
        val e = err("type", """{"text":"你好\n"}""")
        assertTrue(reasons(e).contains("message-send"))
        assertTrue(reasons(e).contains("app-category-ask"))

        // A blocked app: invisible, and its visibility exemption is refused wholesale.
        setUpApp("com.example.bad", "坏App", freshPolicy = false)
        assertEquals("app-denied", errCode("find", """{"query":{"role":"Button"}}"""))
        assertEquals("exemption-invalid", controlError { d.grantExemptions(emptyList(), listOf("com.example.bad")) })
        assertEquals("app-denied", errCode("find", """{"query":{"role":"Button"}}"""))

        // A passwords-category app: the same refusal.
        setUpApp("com.example.wallet", "钱包", freshPolicy = false)
        assertEquals("exemption-invalid", controlError { d.grantExemptions(emptyList(), listOf("com.example.wallet")) })
        assertEquals("app-denied", errCode("find", """{"query":{"role":"Button"}}"""))
    }

    private fun controlError(block: () -> Unit): String = try {
        block()
        throw AssertionError("expected exemption-invalid")
    } catch (e: AgentError) {
        e.errorCode
    }

    // ---- press Enter, the same judgment as a typed newline ---------------------------

    @Test fun enterInMessagingGatesLikeATypedNewline() {
        val input = FakeNode("EditText", "", className = "android.widget.EditText", rect = Rect(0, 2200, 900, 90), isEditable = true)
        setUpApp("com.tencent.mm", "微信", root = single(input))
        dev.focused = input
        // ① The plain message does not gate; the Enter that sends it does.
        call("type", """{"text":"你好"}""")
        assertTrue("setText =你好" in dev.log)
        val e = err("press", """{"key":"Enter"}""")
        assertEquals("approval-required", e.errorCode)
        assertTrue(reasons(e).contains("message-send"))
        assertFalse(dev.log.any { it == "enter" })
    }

    @Test fun enterAndTypedNewlineInAnUnknownAppStayStrict() {
        // ② Outside messaging and social apps the commit default applies.
        val input = FakeNode("EditText", "", className = "android.widget.EditText", rect = Rect(0, 2200, 900, 90), isEditable = true)
        setUpApp("com.example.notes", "笔记", root = single(input))
        dev.focused = input
        val e = err("type", """{"text":"完成\n"}""")
        assertEquals("approval-required", e.errorCode)
        assertTrue(reasons(e).contains("commit-unrecognized"))
        val e2 = err("press", """{"key":"Enter"}""")
        assertEquals("approval-required", e2.errorCode)
        assertTrue(reasons(e2).contains("commit-unrecognized"))
        assertFalse(dev.log.any { it == "enter" })
    }

    @Test fun enterAndBackInADeniedAppAreRefused() {
        // ③ Deny visibility covers the keyboard too.
        val input = FakeNode("EditText", "", className = "android.widget.EditText", rect = Rect(0, 2200, 900, 90), isEditable = true)
        setUpApp("com.eg.android.AlipayGphone", "支付宝", root = single(input))
        dev.focused = input
        assertEquals("app-denied", errCode("press", """{"key":"Enter"}"""))
        assertEquals("app-denied", errCode("press", """{"key":"Back"}"""))
    }

    @Test fun searchFieldEnterAndNewlineRunFree() {
        // ④ A search field submits a query, not a commit.
        val search = FakeNode("EditText", "搜索商家", className = "android.widget.EditText", text = "", rect = Rect(0, 100, 900, 90), isEditable = true)
        setUpApp("com.example.shop", "商店", root = single(search))
        dev.focused = search
        call("press", """{"key":"Enter"}""")
        call("type", """{"text":"关键词\n"}""")
        assertTrue("enter" in dev.log)
        assertTrue("setText 搜索商家=关键词\n" in dev.log)
    }

    @Test fun enterApprovalIsReplayedAndConsumedOnce() {
        // ⑤ The approval credential flows through the same four checks and buys one action.
        val input = FakeNode("EditText", "", className = "android.widget.EditText", rect = Rect(0, 2200, 900, 90), isEditable = true)
        setUpApp("com.tencent.mm", "微信", root = single(input))
        dev.focused = input
        val e = err("press", """{"key":"Enter"}""")
        assertEquals("approval-required", e.errorCode)
        call("press", """{"key":"Enter","approval":${approvalOf(e)}}""")
        assertTrue("enter" in dev.log)
        assertEquals("approval-used", errCode("press", """{"key":"Enter","approval":${approvalOf(e)}}"""))
        assertEquals(1, dev.log.count { it == "enter" })
    }

    // ---- the walkthrough ------------------------------------------------------------

    @Test fun cartToOrderWalkthrough() {
        setUpApp("com.example.shop", "商店")
        val r = ref("Button", 1800)
        // 1. The submit button is held with a semantics receipt.
        val e = err("invoke", """{"ref":"$r"}""")
        assertEquals("approval-required", e.errorCode)
        // 2. The caller suspends and sets busy.
        d.setBusy(true, "审批中")
        assertEquals("device-busy", errCode("invoke", """{"ref":"$r"}"""))
        call("status", """{"text":"等审批"}""")
        // 3. Approval lands; busy is lifted and the same call is resent with the credential.
        d.setBusy(false, null)
        call("invoke", """{"ref":"$r","approval":${approvalOf(e)}}""")
        assertTrue("click 立即支付" in dev.log)
        // 4. Replaying the credential fails: one approval, one action.
        assertEquals("approval-used", errCode("invoke", """{"ref":"$r","approval":${approvalOf(e)}}"""))
        assertEquals(1, dev.log.count { it.startsWith("click") })
    }
}
