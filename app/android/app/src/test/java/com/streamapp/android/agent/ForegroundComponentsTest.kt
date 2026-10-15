package com.streamapp.android.agent

import org.junit.Assert.assertEquals
import org.junit.Test

class ForegroundComponentsTest {
    @Test fun aBackgroundAppsEventDoesNotRenameTheForeground() {
        val c = ForegroundComponents()
        c.windowStateChanged("com.sankuai.meituan", "com.meituan.android.pt.homepage.activity.MainActivity")
        c.windowStateChanged("com.hexin.plat.android", "com.hexin.plat.android.SomeActivity") // a background app
        assertEquals("com.sankuai.meituan/com.meituan.android.pt.homepage.activity.MainActivity", c.componentOf("com.sankuai.meituan"))
    }

    @Test fun anAppWithNoActivitySeenIsJustItsPackage() {
        assertEquals("com.miui.home", ForegroundComponents().componentOf("com.miui.home"))
        assertEquals("", ForegroundComponents().componentOf(null))
    }

    @Test fun aToastOrDialogClassIsNotAPlace() {
        val c = ForegroundComponents()
        c.windowStateChanged("me.ele", "me.ele.Launcher")
        c.windowStateChanged("me.ele", "android.widget.Toast\$TN")
        c.windowStateChanged("me.ele", "android.app.Dialog")
        assertEquals("me.ele/me.ele.Launcher", c.componentOf("me.ele"))
    }
}
