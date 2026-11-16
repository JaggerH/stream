// A separate Gradle build standing in for a third-party host app. It pulls the agent library in
// from the Stream Android build next door by its coordinates, the same way it would from a repo:
//   ../gradlew -p sample-host :app:assembleDebug
pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "agent-sample-host"
includeBuild("..") {
    dependencySubstitution {
        substitute(module("com.streamapp.android:agent")).using(project(":agent"))
    }
}
include(":app")
