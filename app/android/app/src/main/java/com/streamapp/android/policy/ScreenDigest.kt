package com.streamapp.android.policy

import com.streamapp.android.agent.UiNode
import java.security.MessageDigest

/**
 * The screen digest: a canonical hash over the **masked** accessibility tree snapshot, so it is
 * stable (masking is deterministic) and leaks nothing (the masked values are dotted out).
 *
 * Serialization, frozen as of this version and pinned by tests (`ScreenDigestTest`): a walk in
 * document order starting at the root; one line per visible node (positive width and height) —
 * `role|className|x,y,w,h|maskedName|viewId` — joined with `\n`, hashed as
 * SHA-256 over `"stream-screen-v1\n" + lines`. Nodes of purely transient views (images, pagers,
 * video and texture surfaces, progress and seek bars) are skipped, so an animation ticking
 * elsewhere on the page does not stale an approval — the same carousel stance as `stale-ref`.
 * Changing any of this changes every outstanding approval's digest and is a major-version event.
 */
object ScreenDigest {
    const val VERSION_PREFIX = "stream-screen-v1\n"

    /** Class-name fragments of views whose mere repaint or bounds drift must not stale an approval. */
    private val TRANSIENT = listOf("Image", "Pager", "Video", "Texture", "Surface", "Progress", "Seek")

    fun isTransient(n: UiNode) = TRANSIENT.any { n.className.contains(it, ignoreCase = true) || n.role.contains(it, ignoreCase = true) }

    fun lines(root: UiNode): List<String> {
        val out = mutableListOf<String>()
        fun walk(n: UiNode) {
            if (!isTransient(n) && n.rect.w > 0 && n.rect.h > 0) {
                out += "${n.role}|${n.className}|${n.rect.x},${n.rect.y},${n.rect.w},${n.rect.h}|${n.name}|${n.viewId}"
            }
            n.children.forEach(::walk)
        }
        walk(root)
        return out
    }

    fun serialize(root: UiNode): String = VERSION_PREFIX + lines(root).joinToString("\n")

    fun of(root: UiNode): String = sha256(serialize(root))

    fun sha256(s: String): String =
        MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
}
