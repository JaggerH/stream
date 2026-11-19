package com.streamapp.android.agent

import java.security.MessageDigest
import kotlin.math.roundToInt

/**
 * One text line recognized on the screen. [rect] is in frame pixels; the frame is the whole
 * screen, so the rect is a screen rect too. [confidence] is the engine's mean confidence for the
 * line, 0..1.
 */
internal data class OcrText(val text: String, val rect: Rect, val confidence: Double)

/**
 * The device-side recognizer behind `find`'s `ocr` argument. Implementations run on the op
 * worker, see JPEG bytes (a frame the caller never receives) and return what they read. A frame
 * with no text is an empty list, not an error; an engine that cannot run throws, and the caller
 * reports the OCR as failed rather than failing the read.
 *
 * The contract is deliberately smaller than any particular engine: the production one is
 * Tesseract (see `ocr/TesseractOcrEngine.kt`), tests pass a fake.
 */
internal interface OcrEngine {
    /** Recognize [jpeg]; rects are in the frame's pixel coordinates, confidence in 0..1. */
    fun recognize(jpeg: ByteArray): List<OcrText>
}

/**
 * An OCR line as a query/action target, in the same shape as an accessibility element: role
 * `ocr-text`, the line as its name. It has no live node behind it, so `invoke` on its ref taps
 * its centre instead of running an accessibility action.
 */
internal class OcrTextNode(
    override val name: String,
    override val rect: Rect,
    val confidence: Double,
) : UiNode {
    override val role: String = "ocr-text"
    override val className: String = "ocr"
    override val text: String = name
    override val children: List<UiNode> = emptyList()
    override val isClickable: Boolean = true
}

/** The outcome of one OCR read: what it produced, whether it was reused, how long it took. */
internal class OcrRead(
    val texts: List<OcrText>,
    val cached: Boolean,
    val ms: Long,
    /** Set when recognition could not run; [texts] is empty then. */
    val error: String? = null,
)

/**
 * Recognition results keyed by the frame's SHA-256, so the same screen is recognized once. The
 * screenshot throttle (~1.1 s between captures) and the engine's cost both apply per frame, not
 * per read: `find` with `ocr` and a `click` whose point the tree cannot name share the entry.
 * Bounded to the last [capacity] frames — recognition results are a few lines each, but a page
 * that animates must not grow the cache.
 */
internal class OcrFrames(
    private val engine: () -> OcrEngine?,
    private val now: () -> Long = { System.currentTimeMillis() },
    capacity: Int = 8,
) {
    private val cache = object : LinkedHashMap<String, List<OcrText>>(capacity, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, List<OcrText>>?) = size > capacity
    }

    /** Whether an engine exists at all; a caller can skip the screenshot when it does not. */
    fun available(): Boolean = engine() != null

    /** Recognize [shot], or reuse the last result for the same frame bytes. Never throws. */
    fun read(shot: Shot): OcrRead {
        val key = sha256(shot.jpeg)
        cache[key]?.let { return OcrRead(it, cached = true, ms = 0) }
        val eng = engine() ?: return OcrRead(emptyList(), cached = false, ms = 0, error = "ocr-unavailable: 设备上没有可用的文字识别引擎")
        val started = now()
        val texts = try {
            eng.recognize(shot.jpeg).mapNotNull { t ->
                val text = t.text.trim()
                if (text.isEmpty() || t.rect.w <= 0 || t.rect.h <= 0) null
                else OcrText(text, t.rect, normalizeConfidence(t.confidence))
            }
        } catch (e: Exception) {
            return OcrRead(emptyList(), cached = false, ms = now() - started,
                error = "ocr-failed: 文字识别没能运行（${e.message ?: e.javaClass.simpleName}）")
        }
        val ms = now() - started
        cache[key] = texts
        return OcrRead(texts, cached = false, ms = ms)
    }

    private fun normalizeConfidence(c: Double): Double {
        val v = if (c > 1.0) c / 100.0 else c
        return (v.coerceIn(0.0, 1.0) * 1000.0).roundToInt() / 1000.0
    }

    private companion object {
        fun sha256(bytes: ByteArray): String =
            MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    }
}

/** The smallest text line covering ([x], [y]); null when the point is on no line. */
internal fun List<OcrText>.at(x: Int, y: Int): OcrText? =
    filter { x >= it.rect.x && x < it.rect.x + it.rect.w && y >= it.rect.y && y < it.rect.y + it.rect.h }
        .minByOrNull { it.rect.w.toLong() * it.rect.h.toLong() }

/** A synthetic root so the ordinary query walk can search OCR lines like a window's tree. */
internal class OcrRoot(private val texts: List<UiNode>, private val bounds: Rect) : UiNode {
    override val role: String = "ocr-root"
    override val name: String = ""
    override val className: String = "ocr"
    override val text: String = ""
    override val rect: Rect = bounds
    override val children: List<UiNode> = texts
}

/** How `find` treats OCR: `auto` only when the tree cannot see, `on` always, `off` never. */
internal enum class OcrMode(val wire: String) {
    AUTO("auto"), ON("on"), OFF("off");

    companion object {
        fun parse(s: String): OcrMode = entries.firstOrNull { it.wire == s }
            ?: throw AgentError("unsupported-ocr: ocr 只能是 auto、on 或 off（收到「$s」）")
    }
}

/** A foreground window counts as "cannot see" below this many visible named nodes. */
internal const val OCR_NAMED_NODE_MIN = 3
