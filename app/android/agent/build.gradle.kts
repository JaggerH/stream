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
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }
    testOptions { unitTests.isReturnDefaultValues = false }
}

// Every public declaration says so; tests are exempt.
kotlin { explicitApi() }

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    testImplementation("junit:junit:4.13.2")
    // android.jar's org.json is a stub on the JVM; tests need the real one.
    testImplementation("org.json:json:20240303")
}
