#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, join, resolve } from "node:path";

import { buildAndroidWrapper } from "./android-wrapper";

type BuildRequest = {
  projectId?: string;
  appName?: string;
  packageId?: string;
  previewUrl?: string;
  artifactName?: string;
};

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function collectBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolveBody(body));
    req.on("error", reject);
  });
}

function requireToken(req: IncomingMessage): boolean {
  const token = process.env.FORGE_ANDROID_APK_BUILDER_TOKEN;
  if (!token) return true;
  return req.headers.authorization === `Bearer ${token}`;
}

export function artifactRoot(): string {
  return resolve(process.env.FORGE_ANDROID_APK_ARTIFACT_DIR ?? "/home/v0id/.hermes/run/forge-android-apks");
}

export function publicBaseUrl(req: Pick<IncomingMessage, "headers">): string {
  const configured = process.env.FORGE_ANDROID_APK_BUILDER_PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/+$/, "");
  const host = req.headers.host ?? `127.0.0.1:${process.env.PORT ?? "8787"}`;
  return `http://${host}`;
}

function safeArtifactName(input: string | undefined, fallback: string): string {
  const name = basename(input || fallback).replace(/[^a-z0-9_.-]/gi, "-");
  return name.endsWith(".apk") ? name : `${name}.apk`;
}

async function handleBuild(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!requireToken(req)) return json(res, 401, { error: "Unauthorized" });
  const payload = JSON.parse(await collectBody(req)) as BuildRequest;
  if (!payload.appName || !payload.previewUrl) {
    return json(res, 400, { error: "appName and previewUrl are required" });
  }

  const outputDir = artifactRoot();
  await mkdir(outputDir, { recursive: true });
  const artifactName = safeArtifactName(payload.artifactName, `${payload.packageId ?? "forge-app"}-debug.apk`);
  const output = join(outputDir, artifactName);
  const result = await buildAndroidWrapper({
    appName: payload.appName,
    packageId: payload.packageId,
    previewUrl: payload.previewUrl,
    output,
  });
  const size = (await stat(result.apkPath)).size;
  const downloadUrl = `${publicBaseUrl(req)}/artifacts/${encodeURIComponent(artifactName)}`;
  return json(res, 200, {
    downloadUrl,
    artifactName,
    size,
    packageId: result.spec.packageId,
    appName: result.spec.appName,
    previewUrl: result.spec.previewUrl,
  });
}

async function handleArtifact(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const encoded = req.url?.replace(/^\/artifacts\//, "") ?? "";
  const artifactName = basename(decodeURIComponent(encoded));
  if (!artifactName.endsWith(".apk")) return json(res, 404, { error: "Not found" });
  const file = join(artifactRoot(), artifactName);
  let info;
  try {
    info = await stat(file);
  } catch {
    return json(res, 404, { error: "Not found" });
  }
  res.writeHead(200, {
    "Content-Type": "application/vnd.android.package-archive",
    "Content-Length": info.size,
    "Content-Disposition": `attachment; filename=\"${artifactName}\"`,
  });
  createReadStream(file).pipe(res);
}

export function createAndroidBuilderServer() {
  return createServer((req, res) => {
    Promise.resolve()
      .then(async () => {
        if (req.method === "POST" && req.url === "/build") return await handleBuild(req, res);
        if (req.method === "GET" && req.url?.startsWith("/artifacts/")) return await handleArtifact(req, res);
        if (req.method === "GET" && req.url === "/health") return json(res, 200, { ok: true });
        return json(res, 404, { error: "Not found" });
      })
      .catch((err) => json(res, 500, { error: err instanceof Error ? err.message : String(err) }));
  });
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? "8787");
  await mkdir(artifactRoot(), { recursive: true });
  const server = createAndroidBuilderServer();
  server.listen(port, "0.0.0.0", () => {
    console.log(`Forge Android APK builder listening on :${port}`);
  });
}

if (process.argv[1]?.endsWith("android-builder-service.ts")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
