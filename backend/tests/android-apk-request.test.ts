import assert from "node:assert/strict";
import test from "node:test";

import {
  androidApkArtifactName,
  androidApkBuildSpec,
  wantsAndroidApk,
} from "../convex/android";

test("Android APK intent matches explicit build/install/share requests", () => {
  assert.equal(wantsAndroidApk("build android apk"), true);
  assert.equal(wantsAndroidApk("give me the Android app"), true);
  assert.equal(wantsAndroidApk("make this installable on my android phone"), true);
  assert.equal(wantsAndroidApk("export an APK for this"), true);
});

test("Android APK intent does not steal normal web edits or iPhone install requests", () => {
  assert.equal(wantsAndroidApk("make the button blue"), false);
  assert.equal(wantsAndroidApk("give me the iPhone install link"), false);
  assert.equal(wantsAndroidApk("download link please"), false);
});

test("Android APK build spec uses the live project preview and safe Forge package metadata", () => {
  const spec = androidApkBuildSpec({
    projectId: "jd7ccdgz0hqqrbp1aj7n4xvwbs88edra",
    name: "A Tiny Habit!",
    previewUrl: "https://3000-example.daytonaproxy01.net/",
  });

  assert.equal(spec.appName, "A Tiny Habit");
  assert.equal(spec.packageId, "com.forge.app.atinyhabit88edra");
  assert.equal(spec.previewUrl, "https://3000-example.daytonaproxy01.net/");
  assert.equal(spec.artifactName, "a-tiny-habit-88edra-debug.apk");
});

test("Android APK artifact names stay stable for hostile app names", () => {
  assert.equal(androidApkArtifactName("!!!", "abc123"), "forge-app-abc123-debug.apk");
});

test("Android APK build spec requires an HTTPS preview URL", () => {
  assert.throws(
    () => androidApkBuildSpec({ projectId: "abc123", name: "Bad", previewUrl: "http://example.test" }),
    /HTTPS preview URL/
  );
});
