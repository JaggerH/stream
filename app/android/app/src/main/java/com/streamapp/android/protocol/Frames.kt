package com.streamapp.android.protocol

import org.json.JSONArray
import org.json.JSONObject

data class Request(val id: Long, val op: String, val args: JSONObject)

data class DeviceState(
    val a11yEnabled: Boolean,
    val screenOn: Boolean,
    val keyguardLocked: Boolean,
    val battery: Int,
    val charging: Boolean,
)

/** The `host-relay.v2` frames this app sends and receives. */
object Frames {
    const val PROTOCOL = "host-relay.v2"

    /** A backend request, or null for anything else. A frame with a non-numeric id is not ours. */
    fun request(raw: String): Request? {
        val o = try { JSONObject(raw) } catch (_: Exception) { return null }
        val id = o.opt("id")
        if (id !is Number) return null
        val op = o.optString("op", "")
        if (op.isEmpty()) return null
        return Request(id.toLong(), op, o.optJSONObject("args") ?: JSONObject())
    }

    fun reply(id: Long, result: Any?): String = JSONObject().put("id", id).put("result", toJson(result)).toString()

    fun error(id: Long, message: String): String = JSONObject().put("id", id).put("error", message).toString()

    fun hello(deviceId: String, name: String, agentVersion: String, ops: List<String>): String =
        JSONObject()
            .put("type", "hello")
            .put("deviceId", deviceId)
            .put("platform", "android")
            .put("name", name)
            .put("agentVersion", agentVersion)
            .put("ops", JSONArray(ops))
            .toString()

    fun state(s: DeviceState): String =
        JSONObject()
            .put("type", "state")
            .put("a11yEnabled", s.a11yEnabled)
            .put("screenOn", s.screenOn)
            .put("keyguardLocked", s.keyguardLocked)
            .put("battery", s.battery)
            .put("charging", s.charging)
            .toString()

    fun abort(): String = JSONObject().put("type", "abort").put("reason", "user").toString()
}
