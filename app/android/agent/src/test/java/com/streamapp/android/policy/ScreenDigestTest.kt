package com.streamapp.android.policy

import com.streamapp.android.agent.FakeNode
import com.streamapp.android.agent.Rect
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.security.MessageDigest

/**
 * The screen digest: the serialization is frozen here, stability and change-sensitivity are
 * pinned, masking feeds it and the digest leaks nothing, and an animation ticking elsewhere on
 * the page does not move it (the carousel stance of stale-ref).
 */
class ScreenDigestTest {
    private lateinit var policy: PolicyContext

    @Before fun setUp() {
        policy = PolicyContext.fromSourceTree("digest-device")
    }

    private fun tree(otp: String = "482913") = FakeNode(
        "FrameLayout", className = "android.widget.FrameLayout", rect = Rect(0, 0, 1080, 2400),
        children = listOf(
            FakeNode("EditText", "", className = "android.widget.EditText", text = otp, rect = Rect(10, 100, 500, 80),
                isEditable = true, viewId = "com.bank:id/otp"),
            FakeNode("Button", "立即支付", className = "android.widget.Button", rect = Rect(10, 2000, 1060, 120), isClickable = true),
        ),
    )

    @Test fun serializationIsFrozen() {
        val masked = policy.masker.maskTree(tree())
        assertEquals(
            "stream-screen-v1\n" +
                "FrameLayout|android.widget.FrameLayout|0,0,1080,2400||\n" +
                "EditText|android.widget.EditText|10,100,500,80|••••••|com.bank:id/otp\n" +
                "Button|android.widget.Button|10,2000,1060,120|立即支付|",
            ScreenDigest.serialize(masked),
        )
    }

    @Test fun digestIsTheHashOfTheSerialization() {
        val s = ScreenDigest.serialize(policy.masker.maskTree(tree()))
        assertEquals(
            MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8))
                .joinToString("") { "%02x".format(it) },
            ScreenDigest.of(policy.masker.maskTree(tree())),
        )
    }

    @Test fun sameScreenSameDigest() {
        assertEquals(ScreenDigest.of(policy.masker.maskTree(tree())), ScreenDigest.of(policy.masker.maskTree(tree())))
    }

    @Test fun contentOrStructureChangesMoveIt() {
        val base = ScreenDigest.of(policy.masker.maskTree(tree()))
        // Masked values are not distinguishable by design (see digestCarriesMaskedValuesOnly);
        // content changes show up through unmasked text.
        val relabeled = FakeNode(
            "FrameLayout", className = "android.widget.FrameLayout", rect = Rect(0, 0, 1080, 2400),
            children = listOf(
                FakeNode("EditText", "", className = "android.widget.EditText", text = "482913", rect = Rect(10, 100, 500, 80),
                    isEditable = true, viewId = "com.bank:id/otp"),
                FakeNode("Button", "确认订单", className = "android.widget.Button", rect = Rect(10, 2000, 1060, 120), isClickable = true),
            ),
        )
        assertNotEquals(base, ScreenDigest.of(policy.masker.maskTree(relabeled)))
        val moved = FakeNode(
            "FrameLayout", className = "android.widget.FrameLayout", rect = Rect(0, 0, 1080, 2400),
            children = listOf(
                FakeNode("EditText", "", className = "android.widget.EditText", text = "482913", rect = Rect(10, 120, 500, 80),
                    isEditable = true, viewId = "com.bank:id/otp"),
                FakeNode("Button", "立即支付", className = "android.widget.Button", rect = Rect(10, 2000, 1060, 120), isClickable = true),
            ),
        )
        assertNotEquals(base, ScreenDigest.of(policy.masker.maskTree(moved)))
    }

    @Test fun carouselElsewhereDoesNotMoveIt() {
        fun carousel(at: Int) = FakeNode(
            "ViewPager", "轮播", className = "androidx.viewpager.widget.ViewPager", rect = Rect(0, at, 1080, 400),
            children = listOf(FakeNode("ImageView", "banner", className = "android.widget.ImageView", rect = Rect(0, at, 1080, 400))),
        )
        val a = FakeNode("FrameLayout", className = "android.widget.FrameLayout", rect = Rect(0, 0, 1080, 2400),
            children = listOf(carousel(0), FakeNode("Button", "立即支付", className = "android.widget.Button", rect = Rect(10, 2000, 1060, 120))))
        val b = FakeNode("FrameLayout", className = "android.widget.FrameLayout", rect = Rect(0, 0, 1080, 2400),
            children = listOf(carousel(320), FakeNode("Button", "立即支付", className = "android.widget.Button", rect = Rect(10, 2000, 1060, 120))))
        assertEquals(ScreenDigest.of(a), ScreenDigest.of(b))
    }

    @Test fun digestCarriesMaskedValuesOnly() {
        val s = ScreenDigest.serialize(policy.masker.maskTree(tree()))
        assertFalse(s.contains("482913"))
        // Two screens differing only in the code's value hash equal: nothing leaks.
        assertEquals(
            ScreenDigest.of(policy.masker.maskTree(tree(otp = "111111"))),
            ScreenDigest.of(policy.masker.maskTree(tree(otp = "222222"))),
        )
    }

    @Test fun canonicalJsonIsSortedAndWhitespaceFree() {
        val o = JSONObject("""{"ref":"g1-0","rect":{"x":1,"w":50,"y":2,"h":40}}""")
        assertEquals("""{"rect":{"h":40,"w":50,"x":1,"y":2},"ref":"g1-0"}""", policy.canonical(o))
    }

    @Test fun bindingDigestTiesDeviceLeaseOpAndArgs() {
        val args = JSONObject("""{"ref":"g1-0"}""")
        val b1 = policy.bindingDigest("click", args)
        assertEquals(b1, policy.bindingDigest("click", args))
        // Carrying the approval back must not change the digest: the resend hashes like the ask.
        val argsWithApproval = JSONObject("""{"ref":"g1-0","approval":{"id":"a1"}}""")
        assertEquals(b1, policy.bindingDigest("click", argsWithApproval))
        assertNotEquals(b1, policy.bindingDigest("invoke", args))
        assertNotEquals(b1, policy.bindingDigest("click", JSONObject("""{"ref":"g1-1"}""")))
        val other = PolicyContext.fromSourceTree("digest-device")
        assertNotEquals(b1, other.bindingDigest("click", args)) // new process, new lease
        // The digest hides its inputs.
        assertFalse(b1.contains("g1-0"))
        assertFalse(b1.contains(policy.leaseId))
    }
}
