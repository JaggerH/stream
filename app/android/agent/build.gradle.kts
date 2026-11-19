plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

// The execution agent as a library: protocol, op dispatcher, accessibility service, takeover
// banner, policy gate, relay connection, pairing and credentials. Its one public entry point is
// `com.streamapp.android.StreamAgent`; everything else is `internal` (explicit API mode).
android {
    namespace = "com.streamapp.android.agentlib"
    compileSdk = 35
    defaultConfig {
        minSdk = 30
        buildConfigField("String", "AGENT_VERSION", "\"${rootProject.extra["streamVersionName"]}\"")
        // A host without the androidx view-tree owner libraries must still shrink cleanly.
        consumerProguardFiles("consumer-rules.pro")
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }
    testOptions {
        unitTests.isReturnDefaultValues = false
        // Robolectric tests attach real views to a window.
        unitTests.isIncludeAndroidResources = true
    }
}

// Every public declaration says so; tests are exempt.
kotlin { explicitApi() }

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // On-device text recognition (Apache-2.0) for the OCR tier: `find`'s `ocr` argument and the
    // text under a coordinate tap the accessibility tree cannot name. The tessdata models are
    // downloaded on first use, not bundled (see ocr/TesseractOcrEngine.kt and THIRD-PARTY-NOTICE).
    implementation("cz.adaptech.tesseract4android:tesseract4android:4.9.0")
    // The view-tree owners (lifecycle, view model store, saved state, back press, fully drawn) the
    // indicator's window root carries over from the host's view. Compile-only: the agent imposes
    // none of them; a host that renders with Compose (or any other user of these owners) already
    // ships them, and without them the copy is skipped (see a11y/ViewTreeOwners.kt).
    compileOnly("androidx.lifecycle:lifecycle-runtime:2.6.2")
    compileOnly("androidx.lifecycle:lifecycle-viewmodel:2.6.2")
    compileOnly("androidx.savedstate:savedstate:1.2.1")
    compileOnly("androidx.activity:activity:1.9.3")
    testImplementation("junit:junit:4.13.2")
    // android.jar's org.json is a stub on the JVM; tests need the real one.
    testImplementation("org.json:json:20240303")
    testImplementation("org.robolectric:robolectric:4.14.1")
    testImplementation("androidx.lifecycle:lifecycle-runtime:2.6.2")
    testImplementation("androidx.lifecycle:lifecycle-viewmodel:2.6.2")
    testImplementation("androidx.savedstate:savedstate:1.2.1")
    testImplementation("androidx.activity:activity:1.9.3")
}
