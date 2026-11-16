pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "stream-android"
// `:agent` is the execution agent as a library (see docs/API.md, "Embedding the Android agent"); `:app` is the Stream app
// that wraps it. A host app embeds `:agent` the way `sample-host/` does.
include(":agent")
include(":app")
