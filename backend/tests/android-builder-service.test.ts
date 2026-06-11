import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { createAndroidBuilderServer, artifactRoot, publicBaseUrl } from "../scripts/android-builder-service";

test("builder service helpers use durable artifact dir and configured public base URL", () => {
  const oldDir = process.env.FORGE_ANDROID_APK_ARTIFACT_DIR;
  const oldBase = process.env.FORGE_ANDROID_APK_BUILDER_PUBLIC_BASE_URL;
  process.env.FORGE_ANDROID_APK_ARTIFACT_DIR = "/var/tmp/forge-test-apks";
  process.env.FORGE_ANDROID_APK_BUILDER_PUBLIC_BASE_URL = "https://forge-builder.example/";
  try {
    assert.equal(artifactRoot(), "/var/tmp/forge-test-apks");
    assert.equal(publicBaseUrl({ headers: {} } as any), "https://forge-builder.example");
  } finally {
    if (oldDir === undefined) delete process.env.FORGE_ANDROID_APK_ARTIFACT_DIR;
    else process.env.FORGE_ANDROID_APK_ARTIFACT_DIR = oldDir;
    if (oldBase === undefined) delete process.env.FORGE_ANDROID_APK_BUILDER_PUBLIC_BASE_URL;
    else process.env.FORGE_ANDROID_APK_BUILDER_PUBLIC_BASE_URL = oldBase;
  }
});

test("builder service requires bearer token and serves APK artifacts", async () => {
  const root = await mkdir(join(tmpdir(), `forge-builder-test-${Date.now()}`), { recursive: true }).then(() => join(tmpdir(), `forge-builder-test-${Date.now()}`));
  await mkdir(root, { recursive: true });
  const oldDir = process.env.FORGE_ANDROID_APK_ARTIFACT_DIR;
  const oldToken = process.env.FORGE_ANDROID_APK_BUILDER_TOKEN;
  process.env.FORGE_ANDROID_APK_ARTIFACT_DIR = root;
  process.env.FORGE_ANDROID_APK_BUILDER_TOKEN = "test-token";
  const artifact = join(root, "demo.apk");
  await writeFile(artifact, Buffer.from("not really an apk"));

  const server = createAndroidBuilderServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const unauth = await fetch(`${base}/build`, { method: "POST", body: "{}" });
    assert.equal(unauth.status, 401);

    const invalid = await fetch(`${base}/build`, {
      method: "POST",
      headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(invalid.status, 400);

    const artifactRes = await fetch(`${base}/artifacts/demo.apk`, { headers: { Range: "bytes=0-0" } });
    assert.equal(artifactRes.status, 200);
    assert.equal(artifactRes.headers.get("content-type"), "application/vnd.android.package-archive");
    assert.equal((await readFile(artifact)).byteLength, (await stat(artifact)).size);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (oldDir === undefined) delete process.env.FORGE_ANDROID_APK_ARTIFACT_DIR;
    else process.env.FORGE_ANDROID_APK_ARTIFACT_DIR = oldDir;
    if (oldToken === undefined) delete process.env.FORGE_ANDROID_APK_BUILDER_TOKEN;
    else process.env.FORGE_ANDROID_APK_BUILDER_TOKEN = oldToken;
    await rm(root, { recursive: true, force: true });
  }
});
