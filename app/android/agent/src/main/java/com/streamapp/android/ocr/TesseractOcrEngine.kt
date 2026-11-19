package com.streamapp.android.ocr

import android.content.Context
import android.graphics.BitmapFactory
import com.googlecode.tesseract.android.TessBaseAPI
import com.streamapp.android.agent.OcrEngine
import com.streamapp.android.agent.OcrText
import com.streamapp.android.agent.Rect
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/**
 * On-device text recognition over Tesseract4Android 4.9.0 (Apache-2.0; Tesseract itself
 * Apache-2.0, Leptonica BSD-2-Clause). Chinese and Latin in one pass, one element per
 * recognized text line — the line granularity is what a caller can click, and line stitching is
 * the caller's business (the desktop text tier has the same boundary).
 *
 * The models are not in the APK: `chi_sim` and `eng` from tessdata_fast 4.1.0 (Apache-2.0, the
 * LSTM models Tesseract 4+ reads) are fetched once, on the first recognition, into
 * `filesDir/tessdata`, pinned by size and SHA-256. A host that would rather not download can
 * pre-place the two files there. A missing or corrupt model makes [recognize] throw; the
 * dispatcher reports OCR as unavailable and the accessibility read still succeeds.
 */
internal class TesseractOcrEngine(
    private val ctx: Context,
    /** The model fetcher; tests replace it. A null result means the download failed. */
    private val fetch: ((String) -> ByteArray?)? = null,
    private val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build(),
) : OcrEngine {
    private val api = TessBaseAPI()
    private var initialized = false

    @Synchronized
    override fun recognize(jpeg: ByteArray): List<OcrText> {
        if (!ready()) throw IllegalStateException("Tesseract 初始化失败：模型缺失或损坏（$TESSDATA/tessdata）")
        val bmp = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size) ?: return emptyList()
        try {
            api.setImage(bmp)
            // A UI screenshot is sparse text, not a page: PSM_SPARSE_TEXT finds labels wherever
            // they are drawn instead of forcing a column layout onto them.
            api.setPageSegMode(TessBaseAPI.PageSegMode.PSM_SPARSE_TEXT)
            val it = api.getResultIterator() ?: return emptyList()
            val out = mutableListOf<OcrText>()
            val level = TessBaseAPI.PageIteratorLevel.RIL_TEXTLINE
            do {
                val text = runCatching { it.getUTF8Text(level) }.getOrNull()?.trim().orEmpty()
                if (text.isEmpty()) continue
                val box = runCatching { it.getBoundingRect(level) }.getOrNull() ?: continue
                if (box.width() <= 0 || box.height() <= 0) continue
                val conf = runCatching { it.confidence(level) }.getOrDefault(0f)
                out += OcrText(text, Rect(box.left, box.top, box.width(), box.height()), (conf / 100.0).coerceIn(0.0, 1.0))
            } while (it.next(level))
            return out
        } finally {
            bmp.recycle()
        }
    }

    /** Whether the models are present and the engine is up. Blocking (may download once). */
    @Synchronized
    fun ready(): Boolean {
        if (initialized) return true
        if (!ensureModels()) return false
        val ok = runCatching { api.init(ctx.filesDir.absolutePath, LANGUAGES, TessBaseAPI.OEM_LSTM_ONLY) }.getOrDefault(false)
        if (!ok) {
            runCatching { api.recycle() }
            return false
        }
        initialized = true
        return true
    }

    /** Ensures both models exist with the pinned bytes; downloads what is missing or wrong. */
    private fun ensureModels(): Boolean {
        val dir = File(ctx.filesDir, TESSDATA)
        if (!dir.isDirectory && !dir.mkdirs()) return false
        for (model in MODELS) {
            val target = File(dir, model.name)
            if (target.isFile && target.length() == model.size.toLong() && sha256(target.readBytes()) == model.sha256) continue
            val bytes = (fetch ?: ::httpGet)(model.url) ?: return false
            if (bytes.size != model.size || sha256(bytes) != model.sha256) return false
            val part = File(dir, "${model.name}.part")
            part.writeBytes(bytes)
            if (!part.renameTo(target)) {
                part.delete()
                return false
            }
        }
        return true
    }

    private class Model(val name: String, val url: String, val size: Int, val sha256: String)

    private companion object {
        /** The directory Tesseract reads `<datapath>/tessdata/<language>.traineddata` from. */
        const val TESSDATA = "tessdata"
        const val LANGUAGES = "chi_sim+eng"

        /** tessdata_fast 4.1.0, Apache-2.0: 2.4 MiB + 3.9 MiB, pinned so a mirror cannot swap them. */
        val MODELS = listOf(
            Model(
                "chi_sim.traineddata",
                "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/chi_sim.traineddata",
                2_469_156,
                "a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730",
            ),
            Model(
                "eng.traineddata",
                "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/eng.traineddata",
                4_113_088,
                "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2",
            ),
        )

        fun sha256(bytes: ByteArray): String =
            MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    }

    private fun httpGet(url: String): ByteArray? = try {
        http.newCall(Request.Builder().url(url).build()).execute().use { r ->
            if (r.isSuccessful) r.body?.bytes() else null
        }
    } catch (e: Exception) {
        null
    }
}
