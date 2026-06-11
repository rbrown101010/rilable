export type AndroidApkBuildSpecInput = {
  projectId: string;
  name: string;
  previewUrl: string;
};

export type AndroidApkBuildSpec = {
  appName: string;
  packageId: string;
  previewUrl: string;
  artifactName: string;
};

function cleanAppName(name: string): string {
  return name.replace(/[^a-z0-9\s-]/gi, " ").replace(/\s+/g, " ").trim().slice(0, 40) || "Forge App";
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function compactSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 32);
}

function suffixFromProjectId(projectId: string): string {
  return projectId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(-6) || "app";
}

function validateHttpsPreviewUrl(previewUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(previewUrl);
  } catch {
    throw new Error("Android APK build requires a valid HTTPS preview URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Android APK build requires an HTTPS preview URL");
  }
  return parsed.toString();
}

export function wantsAndroidApk(text: string): boolean {
  const t = text.toLowerCase();
  if (/\b(android|apk)\b[\s\S]{0,50}\b(apk|app|build|export|install|download|share|phone)\b/.test(t)) return true;
  if (/\b(apk)\b[\s\S]{0,50}\b(android|app|build|export|install|download|share)\b/.test(t)) return true;
  if (/\b(make|build|export|give|get)\b[\s\S]{0,50}\b(android app|apk)\b/.test(t)) return true;
  if (/\binstallable\b[\s\S]{0,50}\bandroid\b/.test(t)) return true;
  return false;
}

export function androidApkArtifactName(name: string, projectId: string): string {
  const appSlug = slugify(cleanAppName(name)) || "forge-app";
  return `${appSlug}-${suffixFromProjectId(projectId)}-debug.apk`;
}

export function androidApkBuildSpec(input: AndroidApkBuildSpecInput): AndroidApkBuildSpec {
  const appName = cleanAppName(input.name);
  const base = compactSlug(appName) || "app";
  const suffix = suffixFromProjectId(input.projectId);
  return {
    appName,
    packageId: `com.forge.app.${base}${suffix}`,
    previewUrl: validateHttpsPreviewUrl(input.previewUrl),
    artifactName: androidApkArtifactName(appName, input.projectId),
  };
}
