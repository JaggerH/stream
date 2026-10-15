package com.streamapp.android.protocol

import org.json.JSONObject

/**
 * What the panel's QR code carries: `{"stream":"pair","v":2,"backends":["http://…",…],"code":"123456"}`,
 * every address the computer has (LAN, Tailscale…), one of which the user picks on the phone.
 * The older `{"v":1,"backend":"http://…"}` is still read.
 */
data class PairPayload(val backends: List<String>, val code: String) {
    companion object {
        private val CODE = Regex("^\\d{6}$")

        fun parse(text: String): PairPayload? {
            val o = try { JSONObject(text) } catch (_: Exception) { return null }
            if (o.optString("stream") != "pair") return null
            val backends = when (o.optInt("v")) {
                1 -> listOf(o.optString("backend"))
                2 -> o.optJSONArray("backends")?.let { a -> (0 until a.length()).map { a.optString(it) } } ?: emptyList()
                else -> return null
            }
            return of(backends, o.optString("code"))
        }

        /** Manual entry: the user types one of the addresses shown under the QR code and the code. */
        fun manual(address: String, code: String): PairPayload? {
            val a = address.trim()
            return of(listOf(if (a.startsWith("http://") || a.startsWith("https://")) a else "http://$a"), code.trim())
        }

        private fun of(backends: List<String>, code: String): PairPayload? {
            if (!CODE.matches(code)) return null
            val ok = backends.filter { it.startsWith("http://") || it.startsWith("https://") }.map { it.trimEnd('/') }
            return if (ok.isEmpty()) null else PairPayload(ok, code)
        }
    }
}

/** One address offered when the QR carries several, with what the user needs to choose. */
data class PairChoice(val backend: String, val label: String)

/**
 * The addresses to offer, reachable ones first: `10.0.0.5:8900 · 局域网 · 能连上`. [reachable] holds
 * the probe results; an address missing from it was not tested in time.
 */
fun pairChoices(backends: List<String>, reachable: Map<String, Boolean>): List<PairChoice> =
    backends.sortedBy { when (reachable[it]) { true -> 0; null -> 1; false -> 2 } }.map { b ->
        val host = b.removePrefix("http://").removePrefix("https://")
        val ip = host.substringBefore(':').split('.').mapNotNull { it.toIntOrNull() }
        val net = if (ip.size == 4 && ip[0] == 100 && ip[1] in 64..127) "Tailscale" else "局域网"
        val state = when (reachable[b]) { true -> "能连上"; false -> "连不上"; null -> "没测出来" }
        PairChoice(b, "$host · $net · $state")
    }

/** `/api/host` on the same backend, with the WebSocket scheme that matches its HTTP scheme. */
fun wsUrl(backend: String): String =
    (if (backend.startsWith("https://")) "wss://" + backend.removePrefix("https://") else "ws://" + backend.removePrefix("http://")) + "/api/host"
