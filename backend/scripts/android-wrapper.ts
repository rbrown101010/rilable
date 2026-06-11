#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

export type AndroidWrapperSpec = {
  appName: string;
  packageId: string;
  previewUrl: string;
};

export type AndroidWrapperWorkspace = {
  spec: AndroidWrapperSpec;
  files: Record<string, string>;
};

export type BuildAndroidWrapperOptions = {
  appName: string;
  previewUrl: string;
  packageId?: string;
  output?: string;
  keepWorkspace?: boolean;
  workspaceDir?: string;
};

export type BuildAndroidWrapperResult = {
  apkPath: string;
  workspaceDir: string;
  spec: AndroidWrapperSpec;
};

function escapeTsString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll("\n", "\\n");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function cleanAppName(appName: string): string {
  return appName.replace(/[^a-z0-9\s-]/gi, " ").replace(/\s+/g, " ").trim().slice(0, 40) || "Forge App";
}

export function normalizeAndroidPackageId(appName: string): string {
  const slug = appName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/^[0-9]+/, (digits) => `app${digits}`)
    .slice(0, 40);
  return `com.forge.${slug || "app"}`;
}

function validatePackageId(packageId: string): void {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/.test(packageId)) {
    throw new Error(`Invalid Android package ID: ${packageId}`);
  }
}

function validatePreviewUrl(previewUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(previewUrl);
  } catch {
    throw new Error("Android wrapper requires a valid HTTPS preview URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Android wrapper requires an HTTPS preview URL");
  }
  return parsed.toString();
}

export function androidWrapperDefaults(input: {
  appName: string;
  previewUrl: string;
  packageId?: string;
}): AndroidWrapperSpec {
  const appName = cleanAppName(input.appName);
  const previewUrl = validatePreviewUrl(input.previewUrl);
  const packageId = input.packageId ?? normalizeAndroidPackageId(appName);
  validatePackageId(packageId);
  return { appName, packageId, previewUrl };
}

export function renderCapacitorConfig(spec: AndroidWrapperSpec): string {
  return `import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: '${escapeTsString(spec.packageId)}',
  appName: '${escapeTsString(spec.appName)}',
  webDir: 'www',
  server: {
    url: '${escapeTsString(spec.previewUrl)}',
    cleartext: false,
  },
};

export default config;
`;
}

function renderPackageJson(spec: AndroidWrapperSpec): string {
  return `${JSON.stringify(
    {
      name: spec.packageId.replaceAll(".", "-"),
      private: true,
      version: "1.0.0",
      scripts: {
        sync: "cap sync android",
        "build:android": "cd android && ./gradlew assembleDebug",
      },
      dependencies: {
        "@capacitor/android": "^8.0.0",
        "@capacitor/cli": "^8.0.0",
        "@capacitor/core": "^8.0.0",
      },
      devDependencies: {
        typescript: "^5.6.0",
      },
    },
    null,
    2
  )}\n`;
}

function renderFallbackIndex(spec: AndroidWrapperSpec): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(spec.appName)}</title>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; background:#111827; color:white; min-height:100vh; display:grid; place-items:center; }
    main { max-width: 34rem; padding: 2rem; text-align:center; }
    a { color:#93c5fd; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(spec.appName)}</h1>
    <p>This local page is only a fallback. Capacitor should load the generated Forge preview directly.</p>
    <p><a href="${escapeHtml(spec.previewUrl)}">Open generated preview</a></p>
  </main>
</body>
</html>
`;
}

export async function createAndroidWrapperWorkspace(spec: AndroidWrapperSpec): Promise<AndroidWrapperWorkspace> {
  validatePackageId(spec.packageId);
  validatePreviewUrl(spec.previewUrl);
  return {
    spec,
    files: {
      "package.json": renderPackageJson(spec),
      "capacitor.config.ts": renderCapacitorConfig(spec),
      "www/index.html": renderFallbackIndex(spec),
      ".gitignore": "node_modules/\nandroid/.gradle/\nandroid/build/\nandroid/app/build/\n*.apk\n",
    },
  };
}

async function writeWorkspace(root: string, workspace: AndroidWrapperWorkspace): Promise<void> {
  for (const [relativePath, content] of Object.entries(workspace.files)) {
    const target = join(root, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit", shell: false });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
    });
  });
}

export async function buildAndroidWrapper(options: BuildAndroidWrapperOptions): Promise<BuildAndroidWrapperResult> {
  const spec = androidWrapperDefaults(options);
  const workspaceDir = options.workspaceDir
    ? resolve(options.workspaceDir)
    : await mkdtemp(join(tmpdir(), "forge-android-"));
  const workspace = await createAndroidWrapperWorkspace(spec);
  await writeWorkspace(workspaceDir, workspace);

  try {
    await run("npm", ["install"], workspaceDir);
    await run("npx", ["cap", "add", "android"], workspaceDir);
    await run("npx", ["cap", "sync", "android"], workspaceDir);
    await run(process.platform === "win32" ? "gradlew.bat" : "./gradlew", ["assembleDebug"], join(workspaceDir, "android"));

    const builtApk = join(workspaceDir, "android/app/build/outputs/apk/debug/app-debug.apk");
    const output = resolve(options.output ?? `${spec.packageId}-debug.apk`);
    await mkdir(dirname(output), { recursive: true });
    const bytes = await readFile(builtApk);
    await writeFile(output, bytes);
    return { apkPath: output, workspaceDir, spec };
  } catch (err) {
    if (!options.keepWorkspace && !options.workspaceDir) await rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

function argValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: tsx scripts/android-wrapper.ts --preview-url URL --app-name NAME [--package-id ID] [--output APK] [--keep-workspace]\n`);
    return;
  }
  const previewUrl = argValue(args, "--preview-url");
  const appName = argValue(args, "--app-name") ?? "Forge App";
  if (!previewUrl) throw new Error("Missing --preview-url");
  const result = await buildAndroidWrapper({
    appName,
    previewUrl,
    packageId: argValue(args, "--package-id"),
    output: argValue(args, "--output"),
    keepWorkspace: args.includes("--keep-workspace"),
    workspaceDir: argValue(args, "--workspace-dir"),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1]?.endsWith("android-wrapper.ts")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
