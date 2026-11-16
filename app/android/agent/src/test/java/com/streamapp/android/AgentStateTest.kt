package com.streamapp.android

import com.streamapp.android.net.REVOKED_STATUS
import org.junit.Assert.assertEquals
import org.junit.Test

class AgentStateTest {
    private fun state(paired: Boolean, text: String) =
        AgentState(paired, AgentConnection.CONNECTED, text, accessibilityEnabled = true, health = null)

    @Test fun aPairedDeviceShowsTheConnectionStatus() {
        assertEquals("已连接 http://10.0.0.5:8900", state(true, "已连接 http://10.0.0.5:8900").displayStatus)
    }

    @Test fun onceUnpairedAStaleStatusReadsAsUnpaired() {
        assertEquals("未配对", state(false, "已连接 http://10.0.0.5:8900").displayStatus)
    }

    @Test fun aRevokedDeviceKeepsSayingSo() {
        assertEquals(REVOKED_STATUS, state(false, REVOKED_STATUS).displayStatus)
    }
}
