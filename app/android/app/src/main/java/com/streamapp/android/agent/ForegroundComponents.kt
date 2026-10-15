package com.streamapp.android.agent

/**
 * The activity each app last showed, so `url` can name the foreground screen. Keyed by package:
 * a window-state event from a background app (a stock ticker, the minus-one screen) must not
 * rename the app actually in front, which is read from the active window at the time of asking.
 */
class ForegroundComponents {
    private val byPackage = HashMap<String, String>()

    /** Only activities name a screen; a Toast or a dialog class is not a place. */
    @Synchronized fun windowStateChanged(pkg: String, cls: String) {
        if (cls.startsWith(pkg) || cls.contains("Activity")) byPackage[pkg] = "$pkg/$cls"
    }

    /** `package/activityClass` of [foregroundPackage], or the package alone when its activity is unknown. */
    @Synchronized fun componentOf(foregroundPackage: String?): String =
        foregroundPackage?.let { byPackage[it] ?: it } ?: ""
}
