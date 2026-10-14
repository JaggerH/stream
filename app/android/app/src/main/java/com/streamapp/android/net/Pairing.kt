package com.streamapp.android.net

import com.streamapp.android.protocol.PairPayload
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

object Pairing {
    fun pair(p: PairPayload, name: String, http: OkHttpClient): Result<Creds> = try {
        val body = JSONObject().put("code", p.code).put("name", name).toString()
        val req = Request.Builder().url("${p.backend}/api/devices/pair").post(body.toRequestBody("application/json".toMediaType())).build()
        http.newCall(req).execute().use { r -> parseResponse(r.code, r.body?.string() ?: "", p.backend) }
    } catch (e: Exception) {
        Result.failure(Exception("连不上 ${p.backend}：${e.message}"))
    }

    fun parseResponse(status: Int, body: String, backend: String): Result<Creds> {
        val o = try { JSONObject(body) } catch (_: Exception) { null }
        if (status == 200 && o != null && o.has("deviceId") && o.has("deviceToken")) {
            return Result.success(Creds(backend, o.getString("deviceId"), o.getString("deviceToken")))
        }
        return Result.failure(Exception(o?.optString("error")?.takeIf { it.isNotEmpty() } ?: "配对失败（HTTP $status）"))
    }
}
