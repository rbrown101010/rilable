# 001: Android Capacitor wrapper

## Question

Given a Forge-generated Daytona preview URL, when we wrap it with Capacitor Android, then can we produce/install an Android app that opens the generated app?

## Approach

- Use Capacitor as the lowest-friction Android shell.
- Point `server.url` at the known-good Daytona preview URL from the live POC smoke.
- Keep `www/index.html` only as a fallback; the Android app should load the remote preview.
- Build with a portable local Android toolchain under `~/.cache/forge-android-tools` so this Linux box can produce debug APKs without Android Studio.

## Target preview

https://3000-ef695e2b-640a-4e19-87e9-27c6a455a3f8.daytonaproxy01.net

## Build commands

From this directory:

```bash
export TOOLS="$HOME/.cache/forge-android-tools"
export JAVA_HOME="$TOOLS/jdk"
export ANDROID_HOME="$TOOLS/android-sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

npx cap sync android
cd android
./gradlew assembleDebug
```

APK output:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

Install on a connected Android device with USB debugging enabled:

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

## Results

- Android project generation: passed.
- Debug APK build: passed.
- APK metadata verification: passed.
- Preview URL availability: passed, HTTP 200.
- Device install: not run; no Android device/emulator attached to this server.

Built artifact copied for delivery:

```text
/home/v0id/.hermes/media_cache/forge-poc-debug.apk
```

Package details:

```text
package: com.forge.poc
label: Forge POC
minSdkVersion: 24
targetSdkVersion: 36
permission: android.permission.INTERNET
signing: Android debug certificate
```

## Verdict: PARTIAL

### What worked

- We produced a real Android debug APK from the current Forge web preview.
- The APK is small enough to share directly for sideload testing (~4 MB).
- No Apple/Chorus path needed. Good. The toll booth can sulk quietly.

### What didn't

- I could not prove launch on-device because no Android device/emulator is attached here.
- This APK is a wrapper around one fixed Daytona preview URL, not yet a dynamic Android Forge client.

### Recommendation for the real build

Use this as the immediate Android proof. If it installs and opens on Cal's phone, the next build step is to make Forge generate/refresh an Android wrapper per project or build a single Android client pointed at Convex project state.
