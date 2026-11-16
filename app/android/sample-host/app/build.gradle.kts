plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.example.agenthost"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.example.agenthost"
        minSdk = 30
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    // Resolved to the `:agent` project of the included Stream Android build (see settings.gradle.kts).
    implementation("com.streamapp.android:agent")
}
