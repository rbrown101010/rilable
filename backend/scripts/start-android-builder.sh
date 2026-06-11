#!/usr/bin/env bash
set -euo pipefail
export PORT="${PORT:-8799}"
export FORGE_ANDROID_APK_ARTIFACT_DIR="${FORGE_ANDROID_APK_ARTIFACT_DIR:-/home/v0id/apk-share/forge-builder-artifacts}"
export FORGE_ANDROID_APK_BUILDER_PUBLIC_BASE_URL="${FORGE_ANDROID_APK_BUILDER_PUBLIC_BASE_URL:-https://virgil-server.tailce4511.ts.net}"
export FORGE_ANDROID_APK_BUILDER_TOKEN="$(cat /home/v0id/.hermes/run/forge_android_builder_token)"
cd /home/v0id/Projects/rilable/backend
exec npm run android:builder
