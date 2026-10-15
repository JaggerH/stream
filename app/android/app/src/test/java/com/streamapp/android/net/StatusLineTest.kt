package com.streamapp.android.net

import org.junit.Assert.assertEquals
import org.junit.Test

class StatusLineTest {
    @Test fun anUnpairedPhoneDoesNotClaimToBeConnected() {
        // 取消配对 stops the service, but the last thing it said was 已连接.
        assertEquals("未配对", shownStatus("已连接 http://10.9.8.21:8900", paired = false))
    }

    @Test fun beingRemovedOnTheComputerIsStillSaid() {
        assertEquals(REVOKED_STATUS, shownStatus(REVOKED_STATUS, paired = false))
    }

    @Test fun aPairedPhoneShowsWhatTheConnectionSays() {
        assertEquals("连接断开（1006），2 秒后重连", shownStatus("连接断开（1006），2 秒后重连", paired = true))
    }
}
