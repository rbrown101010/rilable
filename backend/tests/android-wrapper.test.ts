import assert from "node:assert/strict";
import test from "node:test";

import {
  androidWrapperDefaults,
  createAndroidWrapperWorkspace,
  normalizeAndroidPackageId,
  renderCapacitorConfig,
} from "../scripts/android-wrapper";

test("Android wrapper defaults create a safe Capacitor package from app name and HTTPS preview", () => {
  const spec = androidWrapperDefaults({
    appName: "Migraine Tracker!!!",
    previewUrl: "https://example.com/preview",
  });

  assert.equal(spec.appName, "Migraine Tracker");
  assert.equal(spec.packageId, "com.forge.migrainetracker");
  assert.equal(spec.previewUrl, "https://example.com/preview");
});

test("Android wrapper rejects non-HTTPS preview URLs", () => {
  assert.throws(
    () => androidWrapperDefaults({ appName: "Bad", previewUrl: "http://example.com" }),
    /HTTPS preview URL/
  );
});

test("Android package ID normalization produces valid lowercase dotted IDs", () => {
  assert.equal(normalizeAndroidPackageId("My Cool App 2"), "com.forge.mycoolapp2");
  assert.equal(normalizeAndroidPackageId("123"), "com.forge.app123");
  assert.equal(normalizeAndroidPackageId("!!!"), "com.forge.app");
  assert.equal(normalizeAndroidPackageId("Already.Ok"), "com.forge.alreadyok");
});

test("Capacitor config points Android WebView at the generated preview", () => {
  const config = renderCapacitorConfig({
    appName: "Forge POC",
    packageId: "com.forge.poc",
    previewUrl: "https://preview.example/app",
  });

  assert.match(config, /appId: 'com\.forge\.poc'/);
  assert.match(config, /appName: 'Forge POC'/);
  assert.match(config, /url: 'https:\/\/preview\.example\/app'/);
  assert.match(config, /cleartext: false/);
});

test("Workspace renderer writes the required Capacitor inputs without building", async () => {
  const workspace = await createAndroidWrapperWorkspace({
    appName: "Tiny CRM",
    packageId: "com.forge.tinycrm",
    previewUrl: "https://preview.example/crm",
  });

  assert.ok(workspace.files["package.json"].includes("@capacitor/android"));
  assert.ok(workspace.files["capacitor.config.ts"].includes("https://preview.example/crm"));
  assert.ok(workspace.files["www/index.html"].includes("Open generated preview"));
});
