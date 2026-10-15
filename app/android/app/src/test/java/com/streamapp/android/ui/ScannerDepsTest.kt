package com.streamapp.android.ui

import org.junit.Test

/**
 * zxing-android-embedded calls into androidx.core when its capture screen opens the camera, but
 * does not bring it along: without the dependency the app crashed the moment 扫码配对 was tapped
 * (NoClassDefFoundError: androidx/core/content/ContextCompat, found on the REDMI K80).
 */
class ScannerDepsTest {
    @Test fun theScannersRuntimeClassesAreOnTheClasspath() {
        Class.forName("androidx.core.content.ContextCompat")
        Class.forName("androidx.core.app.ActivityCompat")
    }
}
