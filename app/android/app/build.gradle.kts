plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.streamapp.android"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.streamapp.android"
        minSdk = 30
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            // Sideloaded from the backend. Signed with this machine's debug key so every build from
            // here updates the installed app in place; a store release would need its own key.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }
    testOptions { unitTests.isReturnDefaultValues = false }
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    // The scanner opens the camera through androidx.core (ContextCompat / ActivityCompat) but does
    // not depend on it; without this the app crashes as soon as 扫码配对 opens the camera.
    implementation("androidx.core:core:1.13.1")
    testImplementation("junit:junit:4.13.2")
    // android.jar's org.json is a stub on the JVM; tests need the real one.
    testImplementation("org.json:json:20240303")
}
