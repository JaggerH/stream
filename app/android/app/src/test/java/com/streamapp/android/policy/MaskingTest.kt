package com.streamapp.android.policy

import com.streamapp.android.agent.AgentError
import com.streamapp.android.agent.Device
import com.streamapp.android.agent.Dispatcher
import com.streamapp.android.agent.FakeDevice
import com.streamapp.android.agent.FakeNode
import com.streamapp.android.agent.Rect
import com.streamapp.android.agent.WindowInfo
import com.streamapp.android.protocol.Frames
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Read-layer masking and the credential-field refusal. Every frame the dispatcher can produce
 * against this screen — tree reads, screenshot, receipts, status — is serialized the way the
 * relay would send it, and none of them may carry the password or the one-time code.
 */
class MaskingTest {
    private lateinit var dev: FakeDevice
    private lateinit var shots: RecordingDevice
    private lateinit var d: Dispatcher
    private val password = "hunter2"
    private val otp = "482913"

    /** Keeps the areas the dispatcher asked the screenshot to cover. */
    private class RecordingDevice(val inner: Device) : Device by inner {
        var lastMaskedAreas: List<Rect>? = null
        override fun screenshot(maskedAreas: List<Rect>) =
            inner.screenshot(maskedAreas).also { lastMaskedAreas = maskedAreas }
    }

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

    private fun screen() = FakeNode(
        "FrameLayout", className = "android.widget.FrameLayout", rect = Rect(0, 0, 1080, 2400),
        children = listOf(
            FakeNode("TextView", "您的验证码是 $otp", className = "android.widget.TextView", rect = Rect(0, 500, 1080, 60),
                viewId = "com.bank:id/code_caption"),
            FakeNode("EditText", password, className = "android.widget.EditText", text = password, rect = Rect(0, 600, 1080, 90),
                isEditable = true, viewId = "com.bank:id/password"),
            FakeNode("EditText", otp, className = "android.widget.EditText", text = otp, rect = Rect(0, 700, 1080, 90),
                isEditable = true, viewId = "com.bank:id/otp"),
            FakeNode("Button", "确认收货", className = "android.widget.Button", rect = Rect(0, 2000, 1080, 120), isClickable = true,
                viewId = "com.bank:id/confirm"),
        ),
    )

    @Before fun setUp() {
        dev = FakeDevice()
        dev.wins = mutableListOf(WindowInfo("1", "com.example.bank", "某某银行", true))
        dev.roots["1"] = screen()
        shots = RecordingDevice(dev)
        d = Dispatcher(shots, PolicyContext.fromSourceTree("mask-device"))
        call("scopeWindow", """{"match":{"process":"com.example.bank"}}""")
    }

    private fun refAt(role: String, y: Int): String {
        @Suppress("UNCHECKED_CAST")
        val els = map(call("find", """{"query":{"role":"$role"}}"""))["elements"] as List<Map<String, Any?>>
        return els.first { (it["rect"] as Map<String, Int>)["y"] == y }["ref"] as String
    }

    private fun framesSeen(): List<String> {
        val out = mutableListOf<String>()
        out += Frames.reply(1, call("find", """{"query":{"role":"EditText"}}"""))
        out += Frames.reply(2, call("readSubtree",
            """{"spec":{"itemQuery":{"role":"EditText"},"fields":{"值":{"read":"value"},"名":{"read":"name"}}}}"""))
        out += Frames.reply(3, call("screenshot"))
        out += Frames.reply(4, call("status", """{"text":"下单中"}"""))
        return out
    }

    @Test fun credentialsNeverAppearInAnyOutboundFrame() {
        for (f in framesSeen()) {
            assertFalse(f, f.contains(password))
            assertFalse(f, f.contains(otp))
        }
    }

    @Test fun treeReadsShowMasks() {
        @Suppress("UNCHECKED_CAST")
        val els = map(call("find", """{"query":{"role":"EditText"}}"""))["elements"] as List<Map<String, Any?>>
        assertEquals(listOf(Masker.MASK, Masker.MASK), els.map { it["name"] })
        val rows = call("readSubtree",
            """{"spec":{"itemQuery":{"role":"EditText"},"fields":{"值":{"read":"value"},"名":{"read":"name"}}}}""") as List<Map<String, String>>
        assertEquals(listOf(Masker.MASK, Masker.MASK), rows.map { it["值"] })
        assertEquals(listOf(Masker.MASK, Masker.MASK), rows.map { it["名"] })
    }

    @Test fun codeCaptionDigitsAreMasked() {
        @Suppress("UNCHECKED_CAST")
        val els = map(call("find", """{"query":{"role":"TextView"}}"""))["elements"] as List<Map<String, Any?>>
        assertEquals("您的验证码是 ••••••", els[0]["name"])
    }

    @Test fun screenshotCoversTheCredentialAreas() {
        val f = Frames.reply(1, call("screenshot"))
        assertFalse(f, f.contains(password))
        assertFalse(f, f.contains(otp))
        // The caption and the two credential inputs are covered at the pixel layer.
        assertEquals(3, shots.lastMaskedAreas!!.size)
    }

    @Test fun unlocatableCredentialAreaMeansNoPicture() {
        dev.roots["1"] = FakeNode(
            "FrameLayout", className = "android.widget.FrameLayout", rect = Rect(0, 0, 1080, 2400),
            children = listOf(
                FakeNode("EditText", password, className = "android.widget.EditText", text = password, rect = Rect(0, 0, 0, 0),
                    isEditable = true, viewId = "com.bank:id/password"),
            ),
        )
        assertEquals("secure-window", err("screenshot").errorCode)
    }

    @Test fun credentialFieldsRefuseWrites() {
        // One find for both refs; every rejection below runs against the same ref generation.
        @Suppress("UNCHECKED_CAST")
        val els = map(call("find", """{"query":{"role":"EditText"}}"""))["elements"] as List<Map<String, Any?>>
        val pwRef = els.first { (it["rect"] as Map<String, Int>)["y"] == 600 }["ref"] as String
        val otpRef = els.first { (it["rect"] as Map<String, Int>)["y"] == 700 }["ref"] as String
        for ((ref, viewId) in listOf(pwRef to "com.bank:id/password", otpRef to "com.bank:id/otp")) {
            assertEquals("credential-field-denied", err("setValue", """{"ref":"$ref","text":"x"}""").errorCode)
            dev.focused = dev.roots["1"]!!.children.first { it.viewId == viewId }
            assertEquals("credential-field-denied", err("type", """{"text":"x"}""").errorCode)
            assertEquals("credential-field-denied", err("clearInput").errorCode)
        }
        assertTrue(dev.log.none { it.startsWith("setText") })
    }

    @Test fun anAttachedApprovalDoesNotUnlockCredentialFields() {
        val pwRef = refAt("EditText", 600)
        // Whatever credential the caller attaches — valid-shaped or not — the field refusal comes
        // first: a write to a credential field is never granted, and nothing is consumed.
        val approval = JSONObject()
            .put("id", "approval-1")
            .put("bindingDigest", "0".repeat(64))
            .put("screenDigest", "0".repeat(64))
            .put("expiresAt", System.currentTimeMillis() + 60_000)
            .toString()
        val e = err("setValue", """{"ref":"$pwRef","text":"x","approval":$approval}""")
        assertEquals("credential-field-denied", e.errorCode)
    }

    @Test fun receiptLabelsComeFromTheMaskedTree() {
        dev.roots["1"] = FakeNode(
            "FrameLayout", className = "android.widget.FrameLayout", rect = Rect(0, 0, 1080, 2400),
            children = listOf(FakeNode("Button", "确认验证码 $otp", className = "android.widget.Button", rect = Rect(0, 900, 300, 80), isClickable = true)),
        )
        call("scopeWindow", """{"match":{"process":"com.example.bank"}}""")
        val e = err("invoke", """{"ref":"${refAt("Button", 900)}"}""")
        assertEquals("approval-required", e.errorCode)
        val frame = Frames.error(9, e.message!!, e.errorCode, e.semantics)
        assertFalse(frame, frame.contains(otp))
        assertEquals("确认验证码 ••••••", e.semantics!!.getJSONObject("control").getString("label"))
    }

    @Test fun commitReceiptCarriesSemanticsAndFetchableSnapshot() {
        val e = err("invoke", """{"ref":"${refAt("Button", 2000)}"}""")
        assertEquals("approval-required", e.errorCode)
        val sem = e.semantics!!
        assertEquals("invoke", sem.getString("op"))
        assertEquals("com.example.bank", sem.getJSONObject("app").getString("id"))
        assertEquals("某某银行", sem.getJSONObject("app").getString("name"))
        assertEquals("确认收货", sem.getJSONObject("control").getString("label"))
        assertTrue((0 until sem.getJSONArray("reasons").length()).any { sem.getJSONArray("reasons").getString(it) == "commit-label" })
        assertTrue(sem.getString("bindingDigest").isNotEmpty())
        assertTrue(sem.getString("screenDigest").isNotEmpty())
        val ref = sem.getString("snapshotRef")
        val f = Frames.reply(1, call("screenshot", """{"snapshotRef":"$ref"}"""))
        assertFalse(f, f.contains(password))
        assertFalse(f, f.contains(otp))
        assertEquals("stale-ref", err("screenshot", """{"snapshotRef":"snap-none"}""").errorCode)
    }

    /** Reuses the receipt the gate issues: its digests are exactly what a resend carries back. */
    private fun receipt(op: String, args: String): String {
        try {
            call(op, args)
        } catch (e: AgentError) {
            if (e.errorCode != "approval-required") throw AssertionError("expected approval-required, got ${e.errorCode}")
            return JSONObject()
                .put("id", "approval-1")
                .put("bindingDigest", e.semantics!!.getString("bindingDigest"))
                .put("screenDigest", e.semantics.getString("screenDigest"))
                .put("expiresAt", System.currentTimeMillis() + 60_000)
                .toString()
        }
        throw AssertionError("expected the ask to be gated")
    }
}
