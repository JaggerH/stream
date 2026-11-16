plugins {
    id("com.android.application") version "8.7.3" apply false
    id("com.android.library") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
}

// One version for the app and the agent library it wraps: the agent reports it in `hello`.
extra["streamVersionName"] = "0.1.0"
