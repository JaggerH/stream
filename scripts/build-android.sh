#!/usr/bin/env bash
# Test and build the Stream Android app, then stage the APK where the backend serves it
# (GET /panel/android/stream.apk). Run it through scripts/qrun.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export JAVA_HOME="${JAVA_HOME:-$HOME/opt/jdk-17.0.20.1+1}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"
"$ROOT/app/android/gradlew" -p "$ROOT/app/android" --console=plain :app:testDebugUnitTest :app:assembleRelease
mkdir -p "$ROOT/app/dist-panel/android"
cp "$ROOT/app/android/app/build/outputs/apk/release/app-release.apk" "$ROOT/app/dist-panel/android/stream.apk"
echo "[build-android] staged app/dist-panel/android/stream.apk"
