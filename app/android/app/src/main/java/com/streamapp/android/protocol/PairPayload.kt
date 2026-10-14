package com.streamapp.android.protocol

import org.json.JSONObject

/** What the panel's QR code carries: `{"stream":"pair","v":1,"backend":"http://…","code":"123456"}`. */
data class PairPayload(val backend: String, val code: String) {
    companion object {
        private val CODE = Regex("^\\d{6}$")

        fun parse(text: String): PairPayload? {
            val o = try { JSONObject(text) } catch (_: Exception) { return null }
            if (o.optString("stream") != "pair" || o.optInt("v") != 1) return null
            return of(o.optString("backend"), o.optString("code"))
        }

        /** Manual entry: the user types the address shown under the QR code and the code. */
        fun manual(address: String, code: String): PairPayload? {
            val a = address.trim()
            return of(if (a.startsWith("http://") || a.startsWith("https://")) a else "http://$a", code.trim())
        }

        private fun of(backend: String, code: String): PairPayload? {
            if (!(backend.startsWith("http://") || backend.startsWith("https://"))) return null
            if (!CODE.matches(code)) return null
            return PairPayload(backend.trimEnd('/'), code)
        }
    }
}

/** `/api/host` on the same backend, with the WebSocket scheme that matches its HTTP scheme. */
fun wsUrl(backend: String): String =
    (if (backend.startsWith("https://")) "wss://" + backend.removePrefix("https://") else "ws://" + backend.removePrefix("http://")) + "/api/host"
