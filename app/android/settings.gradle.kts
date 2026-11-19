pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    // JitPack serves the on-device OCR library (Tesseract4Android, Apache-2.0); it is not on
    // Maven Central. Nothing else comes from there.
    repositories { google(); mavenCentral(); maven("https://jitpack.io") }
}
rootProject.name = "stream-android"
// `:agent` is the execution agent as a library (see docs/API.md, "Embedding the Android agent"); `:app` is the Stream app
// that wraps it. A host app embeds `:agent` the way `sample-host/` does.
include(":agent")
include(":app")
