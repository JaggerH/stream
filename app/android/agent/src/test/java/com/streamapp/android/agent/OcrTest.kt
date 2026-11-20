package com.streamapp.android.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The screenshot-hash cache and the element shape rules of the OCR tier. */
class OcrTest {
    private val frame = Shot(byteArrayOf(1, 2, 3), Rect(0, 0, 1080, 2400), 2.75)
    private val other = Shot(byteArrayOf(4, 5, 6), Rect(0, 0, 1080, 2400), 2.75)

    @Test fun trimsDropsBlankLinesAndNormalizesConfidence() {
        val engine = FakeOcr(listOf(
            OcrText("  加入购物车 ", Rect(10, 20, 300, 80), 93.0),
            OcrText("   ", Rect(10, 100, 300, 80), 80.0),
            OcrText("价格", Rect(10, 200, 0, 0), 80.0),
        ))
        val read = OcrFrames({ engine }).read(frame)
        assertEquals(1, read.texts.size)
        assertEquals("加入购物车", read.texts[0].text)
        assertEquals(0.93, read.texts[0].confidence, 0.0001)
        assertNull(read.error)
        assertFalse(read.cached)
    }

    @Test fun theSameFrameIsRecognizedOnce() {
        val engine = FakeOcr(listOf(OcrText("提交订单", Rect(0, 0, 100, 40), 0.9)))
        var clock = 0L
        val frames = OcrFrames({ engine }, now = { clock.also { clock += 20 } })
        val first = frames.read(frame)
        assertEquals(20L, first.ms)
        val second = frames.read(frame)
        assertEquals(1, engine.calls)
        assertTrue(second.cached)
        assertEquals(0L, second.ms)
        assertEquals("提交订单", second.texts[0].text)
    }

    @Test fun anotherFrameIsANewRead() {
        val engine = FakeOcr(listOf(OcrText("提交订单", Rect(0, 0, 100, 40), 0.9)))
        val frames = OcrFrames({ engine })
        frames.read(frame)
        frames.read(other)
        assertEquals(2, engine.calls)
    }

    @Test fun aMissingEngineIsReportedNotThrown() {
        val read = OcrFrames({ null }).read(frame)
        assertTrue(read.texts.isEmpty())
        assertTrue(read.error!!.startsWith("ocr-unavailable:"))
    }

    @Test fun anEngineFailureIsReportedNotThrown() {
        val engine = FakeOcr().apply { failure = IllegalStateException("no model") }
        val read = OcrFrames({ engine }).read(frame)
        assertTrue(read.texts.isEmpty())
        assertTrue(read.error!!.startsWith("ocr-failed:"))
    }

    @Test fun thePointPicksTheSmallestLineCoveringIt() {
        val big = OcrText("整行 加入购物车 ¥29", Rect(0, 1900, 1080, 200), 0.9)
        val small = OcrText("加入购物车", Rect(200, 1950, 300, 80), 0.8)
        assertEquals(small, listOf(big, small).at(250, 1980))
        assertNull(listOf(big).at(2000, 3000))
    }

    @Test fun theRectTakesEveryLineDrawnUnderIt() {
        val cart = OcrText("加入购物车", Rect(40, 1140, 200, 60), 0.9)
        val buy = OcrText("立即购买", Rect(480, 1140, 200, 60), 0.9)
        val spec = OcrText("规格", Rect(60, 900, 120, 50), 0.9)
        val bar = Rect(20, 1150, 680, 110) // the whole bottom bar the caller tapped
        assertEquals(listOf(cart, buy), listOf(cart, buy, spec).under(bar))
        // The bar's centre pixel is on neither label; the rect still takes both.
        assertNull(listOf(cart, buy).at(bar.centerX, bar.centerY))
        // A line wholly outside, or one that merely touches the rect, does not count.
        assertEquals(emptyList<OcrText>(), listOf(spec).under(bar))
        assertEquals(emptyList<OcrText>(), listOf(OcrText("远处的字", Rect(0, 1600, 300, 60), 0.9)).under(bar))
        // A small tap on a big line still takes the line: the smaller of the two is covered.
        assertEquals(listOf(cart), listOf(cart).under(Rect(60, 1160, 20, 20)))
    }
}
