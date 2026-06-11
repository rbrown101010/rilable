"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import JSZip from "jszip";
import { resolveModel } from "./models";
import { isPublicAiProxyAllowed } from "./auth";
import { androidApkBuildSpec } from "./android";
import {
  renderPbxproj,
  XCSCHEME,
  ASSETS_ROOT_JSON,
  ASSETS_APPICON_JSON,
  ASSETS_ACCENT_JSON,
} from "./iosTemplate";

// ---------------------------------------------------------------------------
// Daytona REST helpers (web projects)
// ---------------------------------------------------------------------------

const APP_DIR = "/home/daytona/app";
const PORT = 3000;
const HOME_DIR = "/home/daytona";

function daytonaBase(): string {
  return process.env.DAYTONA_API_URL ?? "https://app.daytona.io/api";
}

function daytonaHeaders(): Record<string, string> {
  const key = process.env.DAYTONA_API_KEY;
  if (!key) throw new Error("DAYTONA_API_KEY is not set on the Convex deployment");
  return { Authorization: `Bearer ${key}` };
}

async function daytona(
  path: string,
  init: RequestInit = {},
  timeoutMs = 60_000
): Promise<Response> {
  return await fetch(`${daytonaBase()}${path}`, {
    ...init,
    headers: { ...daytonaHeaders(), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function daytonaJson<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs = 60_000
): Promise<T> {
  const res = await daytona(path, init, timeoutMs);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Daytona ${init.method ?? "GET"} ${path} failed (${res.status}): ${body.slice(0, 300)}`
    );
  }
  return (await res.json()) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type SandboxInfo = { id: string; state: string };

async function getSandbox(id: string): Promise<SandboxInfo> {
  return await daytonaJson<SandboxInfo>(`/sandbox/${id}`);
}

async function waitForSandboxState(
  id: string,
  want: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sb = await getSandbox(id);
    if (sb.state === want) return;
    if (["error", "build_failed", "destroyed"].includes(sb.state)) {
      throw new Error(`Sandbox entered state "${sb.state}"`);
    }
    await sleep(1500);
  }
  throw new Error(`Timed out waiting for sandbox to reach "${want}"`);
}

async function createSandbox(): Promise<string> {
  // Daytona occasionally returns a transient 403 "Region ... is not available"
  // when capacity is tight — retry with backoff before giving up.
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const sandbox = await daytonaJson<SandboxInfo>(
        "/sandbox",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            public: true,
            autoStopInterval: 60,
            labels: { app: "forge" },
          }),
        },
        120_000
      );
      if (sandbox.state !== "started") {
        await waitForSandboxState(sandbox.id, "started", 180_000);
      }
      return sandbox.id;
    } catch (err) {
      lastError = err;
      const message = errorMessage(err);
      const transient = /Region .* is not available|temporarily unavailable|\b(429|502|503)\b/i.test(message);
      if (!transient || attempt === 2) throw err;
      await sleep(8_000 * (attempt + 1));
    }
  }
  throw lastError;
}

async function startSandbox(id: string): Promise<void> {
  const res = await daytona(`/sandbox/${id}/start`, { method: "POST" }, 120_000);
  if (!res.ok && res.status !== 409) {
    throw new Error(`Failed to start sandbox (${res.status})`);
  }
  await waitForSandboxState(id, "started", 180_000);
}

async function execInSandbox(
  id: string,
  command: string,
  timeoutSec = 60,
  cwd = HOME_DIR
): Promise<{ exitCode: number; result: string }> {
  return await daytonaJson<{ exitCode: number; result: string }>(
    `/toolbox/${id}/toolbox/process/execute`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, cwd, timeout: timeoutSec }),
    },
    (timeoutSec + 30) * 1000
  );
}

async function uploadFile(
  sandboxId: string,
  remotePath: string,
  content: string
): Promise<void> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([content], { type: "application/octet-stream" }),
    remotePath.split("/").pop() ?? "file"
  );
  const res = await daytona(
    `/toolbox/${sandboxId}/toolbox/files/upload?path=${encodeURIComponent(remotePath)}`,
    { method: "POST", body: form },
    60_000
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Upload of ${remotePath} failed (${res.status}): ${body.slice(0, 200)}`);
  }
}

async function uploadAppFiles(
  sandboxId: string,
  files: { path: string; content: string }[]
): Promise<void> {
  const dirs = new Set<string>();
  for (const f of files) {
    const idx = f.path.lastIndexOf("/");
    if (idx > 0) dirs.add(f.path.slice(0, idx));
  }
  let mkdir = `mkdir -p ${APP_DIR}`;
  for (const d of dirs) mkdir += ` ${APP_DIR}/${d}`;
  await execInSandbox(sandboxId, mkdir, 30);
  await Promise.all(
    files.map((f) => uploadFile(sandboxId, `${APP_DIR}/${f.path}`, f.content))
  );
}

async function startStaticServer(sandboxId: string): Promise<void> {
  const start =
    `if ! pgrep -f "http.server ${PORT}" >/dev/null; then ` +
    `nohup python3 -m http.server ${PORT} --bind 0.0.0.0 --directory ${APP_DIR} ` +
    `>/tmp/forge-server.log 2>&1 & fi; sleep 1; ` +
    `curl -s -o /dev/null -w "%{http_code}" http://localhost:${PORT}/`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const out = await execInSandbox(sandboxId, start, 30);
    if (out.result.trim().endsWith("200")) return;
    await sleep(1500);
  }
  const log = await execInSandbox(
    sandboxId,
    "tail -5 /tmp/forge-server.log 2>/dev/null || true",
    15
  );
  throw new Error(`Web server failed to start: ${log.result.slice(0, 200)}`);
}

async function getPreviewUrl(sandboxId: string): Promise<string> {
  const data = await daytonaJson<{ url: string }>(
    `/sandbox/${sandboxId}/ports/${PORT}/preview-url`
  );
  return data.url;
}

async function waitForPreview(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (res.ok) return;
    } catch {
      // proxy not ready yet
    }
    await sleep(2_000);
  }
}

// ---------------------------------------------------------------------------
// Chorus REST helpers (mobile projects) — https://ios.chorus.com/llms.txt
// ---------------------------------------------------------------------------

function chorusBase(): string {
  return process.env.CHORUS_API_URL ?? "https://ios.chorus.com";
}

function chorusKey(): string {
  const key = process.env.CHORUS_API_KEY;
  if (!key) throw new Error("CHORUS_API_KEY is not set on the Convex deployment");
  return key;
}

function chorusUserId(): string {
  const id = process.env.CHORUS_USER_ID;
  if (!id) throw new Error("CHORUS_USER_ID is not set on the Convex deployment");
  return id;
}

async function chorus(
  path: string,
  init: RequestInit = {},
  timeoutMs = 60_000
): Promise<Response> {
  return await fetch(`${chorusBase()}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${chorusKey()}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function chorusJson<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs = 60_000
): Promise<T> {
  const res = await chorus(path, init, timeoutMs);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Chorus ${init.method ?? "GET"} ${path} failed (${res.status}): ${body.slice(0, 300)}`
    );
  }
  return (await res.json()) as T;
}

function bundleIdFor(name: string, projectId: string): string {
  const slug =
    name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20) || "app";
  return `com.forge.app.${slug}${projectId.slice(-6).toLowerCase()}`;
}

async function zipMobileProject(
  name: string,
  bundleId: string,
  files: { path: string; content: string }[]
): Promise<Blob> {
  const zip = new JSZip();
  zip.file("App/App.xcodeproj/project.pbxproj", renderPbxproj(name, bundleId));
  zip.file("App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme", XCSCHEME);
  zip.file("App/App/Assets.xcassets/Contents.json", ASSETS_ROOT_JSON);
  zip.file("App/App/Assets.xcassets/AppIcon.appiconset/Contents.json", ASSETS_APPICON_JSON);
  zip.file("App/App/Assets.xcassets/AccentColor.colorset/Contents.json", ASSETS_ACCENT_JSON);
  for (const f of files) {
    zip.file(`App/App/${f.path}`, f.content);
  }
  const bytes = await zip.generateAsync({ type: "arraybuffer" });
  return new Blob([bytes], { type: "application/zip" });
}

type SimPreview = { simBuildId: string; previewUrl: string };

async function mintSimPreview(projectId: string, buildJobId: string): Promise<SimPreview> {
  return await chorusJson<SimPreview>(
    "/api/sim-preview",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-project-id": `forge-${projectId}` },
      body: JSON.stringify({ buildJobId }),
    },
    90_000
  );
}

/// Kick off a Chorus cloud build for the project's current files and schedule
/// polling until it completes.
async function startMobileBuild(
  ctx: ActionCtx,
  projectId: Id<"projects">,
  name: string,
  summary: string,
  files: { path: string; content: string }[],
  isEdit: boolean,
  repairCount = 0
): Promise<void> {
  await setStatus(ctx, projectId, "building", "Compiling your iOS app in the cloud (2–5 min)");
  await log(ctx, projectId, "📦 Uploading source to Chorus…");
  const bundleId = bundleIdFor(name, projectId);
  const zipBlob = await zipMobileProject(name, bundleId, files);
  const form = new FormData();
  form.append("file", zipBlob, "source.zip");
  const job = await chorusJson<{ buildJobId: string }>(
    "/api/build",
    {
      method: "POST",
      headers: { "x-project-id": `forge-${projectId}` },
      body: form,
    },
    180_000
  );
  await ctx.runMutation(internal.projects.update, {
    id: projectId,
    buildJobId: job.buildJobId,
  });
  await log(ctx, projectId, "🏗️ Cloud build started (Xcode on macOS)…");
  await ctx.scheduler.runAfter(15_000, internal.builder.pollMobileBuild, {
    projectId,
    buildJobId: job.buildJobId,
    attempts: 0,
    isEdit,
    summary,
    repairCount,
  });
}

/// Pull deduplicated `file.swift:line: error: …` lines out of the Azure build
/// logs, stripped of timestamps and runner paths.
async function extractBuildErrors(buildJobId: string): Promise<string[]> {
  try {
    const data = await chorusJson<{ logs: { text: string }[] }>(
      `/api/build-jobs/${buildJobId}/logs`,
      {},
      60_000
    );
    const all = data.logs.map((l) => l.text).join("\n");
    const seen = new Set<string>();
    const errors: string[] = [];
    for (const line of all.split("\n")) {
      if (!line.includes("error: ")) continue;
      const cleaned = line
        .replace(/^\S+Z\s+/, "")
        .replace(/^.*\/App\/App\//, "")
        .trim();
      if (!seen.has(cleaned)) {
        seen.add(cleaned);
        errors.push(cleaned);
      }
    }
    return errors;
  } catch {
    return [];
  }
}

async function postLoginLink(
  ctx: ActionCtx,
  projectId: Id<"projects">
): Promise<void> {
  try {
    const link = await chorusJson<{ url: string }>(
      "/api/auth/login-link",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: chorusUserId() }),
      },
      60_000
    );
    await log(
      ctx,
      projectId,
      `🔐 I need access to your Apple Developer account to sign apps.\n\n[Connect your Apple account](${link.url}) — the link expires in 10 minutes. Once you've signed in, ask me for the download link again.`,
      "agent"
    );
  } catch (err) {
    await log(
      ctx,
      projectId,
      `❌ Couldn't prepare an Apple sign-in link: ${errorMessage(err)}`,
      "agent"
    );
  }
}

// ---------------------------------------------------------------------------
// Claude code generation
// ---------------------------------------------------------------------------

const OUTPUT_FORMAT = `OUTPUT FORMAT — follow EXACTLY, with no markdown fences and no commentary before or after:
APP_NAME: <catchy app name, 18 characters max>
APP_EMOJI: <exactly one emoji>
SUMMARY: <one short sentence about what you built>
===FILE: index.html===
<complete file contents>
===END FILE===
===FILE: app.js===
<complete file contents>
===END FILE===`;

const DESIGN_RULES = `RULES:
- Static site only: HTML + CSS + JS. No build step, no npm, no server-side code. Files are served as-is by a static file server.
- index.html is REQUIRED. Put JS in app.js when it exceeds ~80 lines; add style.css for substantial custom CSS. 2-4 files total.
- Tailwind CSS is allowed via <script src="https://cdn.tailwindcss.com"></script>. CDN libraries (unpkg/jsdelivr) are allowed when genuinely useful: Chart.js, Three.js, Tone.js, canvas-confetti, marked, dayjs.
- Use localStorage when the app needs to remember things.
- DESIGN BAR IS HIGH. This must look like a polished product, not a demo: a deliberate color palette with one strong accent, generous spacing, smooth transitions and micro-animations, hover/active states, refined typography (Google Fonts allowed), tasteful gradients or glassmorphism. Default to a dark UI unless the request implies light.
- MOBILE-FIRST: it renders inside an iPhone WebView. Include <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">. Big touch targets, no hover-only interactions, respect safe areas.
- Everything must WORK. Every button does something real. No placeholders, no dead links, no TODOs, no console errors.
- Keep the whole app under ~700 lines total.`;

const GENERATE_SYSTEM = `You are Forge, an elite web-app builder. You produce complete, beautiful, fully-working single-page web apps from a short request.

${OUTPUT_FORMAT}

${DESIGN_RULES}`;

const EDIT_SYSTEM = `You are Forge, an elite web-app builder. You are updating an existing app. You receive the app's current files, recent conversation, and a change request. Re-output the ENTIRE app — every file in full, including unchanged files. Files you omit will be DELETED. Keep the existing APP_NAME and APP_EMOJI unless the user asks to change them; SUMMARY should describe what you changed.

${OUTPUT_FORMAT}

${DESIGN_RULES}`;

const MOBILE_OUTPUT_FORMAT = `OUTPUT FORMAT — follow EXACTLY, with no markdown fences and no commentary before or after:
APP_NAME: <catchy app name, 18 characters max>
APP_EMOJI: <exactly one emoji>
SUMMARY: <one short sentence about what you built>
===FILE: WeatherApp.swift===
<complete file contents>
===END FILE===
===FILE: ContentView.swift===
<complete file contents>
===END FILE===`;

const MOBILE_RULES = `RULES:
- Pure SwiftUI targeting iOS 17. You may use iOS 17 APIs (@Observable, ContentUnavailableView, spring animations) but NOTHING newer than iOS 17.
- 2-5 .swift files with flat PascalCase names like TimerApp.swift, ContentView.swift, Models.swift. No folders, no asset-catalog images, no Info.plist or Xcode project changes.
- EXACTLY ONE file declares \`@main struct SomethingApp: App\`.
- If a file declares ObservableObject or uses @Published it MUST \`import Combine\` (strict member-import visibility). Prefer @Observable from the Observation framework instead.
- The project compiles with default MainActor isolation — write simple main-actor SwiftUI. Avoid Task.detached, custom actors, and Sendable tricks.
- No external packages. No special capabilities or entitlements (no camera, location, push, HealthKit). Avoid network calls; prefer realistic local/simulated data.
- Persist small user data with @AppStorage or UserDefaults.
- Visuals come from SF Symbols, SwiftUI shapes, and gradients only (no image assets).
- DESIGN BAR IS HIGH: this must feel like a polished App Store app — dark theme by default, tasteful gradients, smooth spring animations, generous spacing, rounded cards, haptics via UIImpactFeedbackGenerator (importing UIKit just for haptics is fine).
- Everything must WORK. Every button does something real. No placeholders, no TODOs.
- Keep the whole app under ~600 lines total.`;

const MOBILE_GENERATE_SYSTEM = `You are Forge, an elite iOS engineer. You produce complete, beautiful, fully-working SwiftUI apps from a short request.

${MOBILE_OUTPUT_FORMAT}

${MOBILE_RULES}`;

const MOBILE_EDIT_SYSTEM = `You are Forge, an elite iOS engineer. You are updating an existing SwiftUI app. You receive the app's current files, recent conversation, and a change request. Re-output the ENTIRE app — every file in full, including unchanged files. Files you omit will be DELETED. Keep the existing APP_NAME and APP_EMOJI unless the user asks to change them; SUMMARY should describe what you changed.

${MOBILE_OUTPUT_FORMAT}

${MOBILE_RULES}`;

const MOBILE_FIX_SYSTEM = `You are Forge, an elite iOS engineer. The SwiftUI app below FAILED to compile. Fix every compiler error and re-output the ENTIRE app — every file in full, including unchanged files. Do not change the app's design or features beyond what the fixes require. Keep the existing APP_NAME and APP_EMOJI; SUMMARY should stay a description of the app (not the fix).

${MOBILE_OUTPUT_FORMAT}

${MOBILE_RULES}`;

function fixUserPrompt(
  files: { path: string; content: string }[],
  errors: string[]
): string {
  const fileBlock = files
    .map((f) => `===FILE: ${f.path}===\n${f.content}\n===END FILE===`)
    .join("\n");
  return `CURRENT FILES:\n${fileBlock}\n\nCOMPILER ERRORS:\n${errors.join("\n")}\n\nFix all compiler errors and output the complete corrected app.`;
}

/// Teach the generator that every app has free access to the AI proxy
/// (Vercel AI Gateway, key injected server-side by convex/http.ts).
function aiSkill(platform: "web" | "mobile"): string {
  const site = process.env.CONVEX_SITE_URL;
  if (!site || !isPublicAiProxyAllowed()) return "";
  const endpoint = `${site}/ai/chat/completions`;
  if (platform === "web") {
    return `

AI SKILL — every app you build has FREE access to a built-in AI endpoint (auth is injected server-side; never put an API key in your code and never ask the user for one). Use it whenever the request involves AI: chatbots, writing, summarizing, brainstorming, translation, Q&A, analysis, content generation.
- const res = await fetch("${endpoint}", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: prompt }] }) });
- OpenAI-compatible response: (await res.json()).choices[0].message.content
- Models: "openai/gpt-4o-mini" (fast default) · "anthropic/claude-sonnet-4-6" (smartest) · "anthropic/claude-haiku-4-5" (quick + clever)
- Non-streaming only. Always show a visible loading/thinking state while waiting and a friendly inline error if the call fails.`;
  }
  return `

AI SKILL — every app you build has FREE access to a built-in AI endpoint (auth is injected server-side; never embed an API key and never ask the user for one). Use it whenever the request involves AI: chatbots, writing, summarizing, brainstorming, translation, Q&A, analysis.
- POST ${endpoint} via URLSession with header Content-Type: application/json and JSON body {"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"..."}]}
- Decode the OpenAI-compatible response and read choices[0].message.content
- Models: "openai/gpt-4o-mini" (fast default) · "anthropic/claude-sonnet-4-6" (smartest)
- Calls to THIS endpoint are allowed and encouraged (the avoid-network-calls rule does not apply to it). Show a loading state while waiting; handle failures with a friendly message.`;
}

export const BUILDER_PROVIDER_ENV = "RILABLE_BUILDER_PROVIDER";

function builderProvider(): "anthropic" | "poc-template" {
  const value = (process.env[BUILDER_PROVIDER_ENV] ?? "anthropic").toLowerCase().trim();
  if (["poc-template", "template", "zero-cost"].includes(value)) return "poc-template";
  return "anthropic";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function titleFromPrompt(prompt: string): string {
  const words = prompt
    .replace(/[^a-z0-9\s-]/gi, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3);
  if (words.length === 0) return "POC App";
  return words.map((w) => w[0]?.toUpperCase() + w.slice(1).toLowerCase()).join(" ").slice(0, 18);
}

function isProjectOpsPrompt(prompt: string): boolean {
  const t = prompt.toLowerCase();
  return /\b(project|projects|projectops|dashboard|software|dev|delivery|agile|kanban|backlog|sprint|roadmap)\b/.test(t) &&
    /\b(agile|kanban|backlog|sprint|blocked|blockers|risks|dependencies|owners?|next actions?|recommendations?|software)\b/.test(t);
}

function renderProjectOpsTemplate(): string {
  return [
    "APP_NAME: ProjectOps",
    "APP_EMOJI: 📊",
    "SUMMARY: Agile software delivery board with backlog, Kanban, sprint focus, lightweight dependencies, risks, blocked flag, and AI project manager recommendations.",
    "===FILE: index.html===",
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "  <meta charset=\"utf-8\" />",
    "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\" />",
    "  <title>ProjectOps</title>",
    "  <link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">",
    "  <link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>",
    "  <link href=\"https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800;900&display=swap\" rel=\"stylesheet\">",
    "  <link rel=\"stylesheet\" href=\"style.css\" />",
    "</head>",
    "<body>",
    "  <main class=\"shell\">",
    "    <header class=\"hero\">",
    "      <p class=\"eyebrow\">Virgil software command surface</p>",
    "      <h1>ProjectOps</h1>",
    "      <p>Agile software delivery for Forge-style work: backlog, Kanban, sprint focus, blockers, risks, dependencies, and one AI project manager recommendation.</p>",
    "      <div class=\"metrics\" id=\"metrics\"></div>",
    "    </header>",
    "    <nav class=\"tabs\" aria-label=\"ProjectOps views\">",
    "      <button class=\"tab active\" data-view=\"board\">Kanban board</button>",
    "      <button class=\"tab\" data-view=\"backlog\">Backlog</button>",
    "      <button class=\"tab\" data-view=\"sprint\">Sprint focus</button>",
    "      <button class=\"tab\" data-view=\"risks\">Risks & blockers</button>",
    "      <button class=\"tab\" data-view=\"pm\">AI project manager</button>",
    "    </nav>",
    "    <section class=\"workspace\">",
    "      <form id=\"work-item-form\" class=\"card form-card\">",
    "        <h2>Add / update work item</h2>",
    "        <input name=\"id\" type=\"hidden\" />",
    "        <input name=\"title\" placeholder=\"Feature, bug, chore, or decision\" required />",
    "        <input name=\"owner\" placeholder=\"Owner\" required />",
    "        <select name=\"type\"><option>Feature</option><option>Bug</option><option>Chore</option><option>Decision</option><option>Side quest</option></select>",
    "        <select name=\"status\"><option>Backlog</option><option>Ready</option><option>Doing</option><option>Review</option><option>Done</option></select>",
    "        <select name=\"priority\"><option>High</option><option>Medium</option><option>Low</option><option>Parked</option></select>",
    "        <select name=\"effort\"><option>Small</option><option>Medium</option><option>Large</option></select>",
    "        <label class=\"check\"><input name=\"blocked\" type=\"checkbox\" /> blocked flag</label>",
    "        <textarea name=\"nextAction\" placeholder=\"Next action\" required></textarea>",
    "        <textarea name=\"dependency\" placeholder=\"Dependency or decision needed\"></textarea>",
    "        <textarea name=\"risk\" placeholder=\"Risk / failure mode\"></textarea>",
    "        <button type=\"submit\">Save item</button>",
    "      </form>",
    "      <section class=\"card view-card\"><div class=\"filters\"><label>Status filter <select id=\"status-filter\"><option value=\"all\">All live work</option><option>Backlog</option><option>Ready</option><option>Doing</option><option>Review</option><option>Done</option></select></label><button id=\"clear-done\" type=\"button\">Clear done</button></div><section id=\"view\"></section></section>",
    "    </section>",
    "  </main>",
    "  <script src=\"app.js\"></script>",
    "</body>",
    "</html>",
    "===END FILE===",
    "===FILE: style.css===",
    ":root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; --bg:#07111f; --card:#101c2dcc; --line:#ffffff18; --text:#f8fafc; --muted:#9fb0c7; --accent:#38bdf8; --hot:#fb7185; --ok:#34d399; --warn:#fbbf24; --purple:#a78bfa; }",
    "* { box-sizing: border-box; }",
    "body { margin: 0; min-height: 100vh; background: radial-gradient(circle at 20% 0%, #2563eb66, transparent 34rem), linear-gradient(135deg, #020617, var(--bg)); color: var(--text); }",
    ".shell { width: min(1180px, 100%); margin: 0 auto; padding: max(1.25rem, env(safe-area-inset-top)) 1rem 2rem; }",
    ".hero, .card, .tabs { border: 1px solid var(--line); background: var(--card); border-radius: 26px; box-shadow: 0 24px 90px #0008; backdrop-filter: blur(18px); }",
    ".hero { padding: 1.25rem; }",
    ".eyebrow { color: var(--accent); text-transform: uppercase; letter-spacing: .14em; font-size: .74rem; font-weight: 900; }",
    "h1 { font-size: clamp(2.6rem, 12vw, 6rem); line-height: .86; margin: .2rem 0 .9rem; letter-spacing: -.08em; }",
    "h2, h3 { margin: 0 0 .8rem; }",
    "p { color: var(--muted); line-height: 1.5; }",
    ".metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .7rem; margin-top: 1rem; }",
    ".metric { padding: .8rem; border-radius: 18px; background: #ffffff10; }",
    ".metric strong { display: block; font-size: 1.35rem; }",
    ".tabs { display: flex; gap: .5rem; padding: .45rem; margin: 1rem 0; overflow-x: auto; }",
    "button, input, select, textarea { font: inherit; }",
    "button { border: 0; border-radius: 999px; padding: .85rem 1rem; background: #ffffff14; color: var(--text); font-weight: 900; }",
    "button.active, form button { background: linear-gradient(135deg, #2563eb, #38bdf8); box-shadow: 0 14px 34px #38bdf844; }",
    ".workspace { display: grid; gap: 1rem; }",
    ".card { padding: 1rem; }",
    "form { display: grid; gap: .75rem; }",
    "input, select, textarea { width: 100%; border: 1px solid var(--line); border-radius: 16px; background: #020617aa; color: var(--text); padding: .85rem; }",
    "textarea { min-height: 84px; resize: vertical; }",
    ".filters { display:flex; gap:.7rem; align-items:end; justify-content:space-between; flex-wrap:wrap; margin-bottom:1rem; } .filters label { color:var(--muted); font-weight:800; } .filters select { min-width:160px; margin-top:.3rem; }",
    ".check { color: var(--muted); display:flex; gap:.55rem; align-items:center; } .check input { width:auto; }",
    ".board { display:grid; gap:.75rem; }",
    ".lane, .item, .pm-card { border: 1px solid var(--line); background: #ffffff0e; border-radius: 18px; padding: .9rem; margin: .7rem 0; }",
    ".item-head { display:flex; justify-content:space-between; gap:.75rem; align-items:start; }",
    ".pill { display:inline-flex; border-radius:999px; padding:.26rem .55rem; font-size:.76rem; font-weight:900; background:#ffffff18; color:var(--accent); }",
    ".pill.blocked { color: var(--hot); } .pill.done { color: var(--ok); } .pill.parked { color: var(--warn); } .pill.side { color: var(--purple); }",
    ".meta { color: var(--muted); font-size:.88rem; margin-top:.45rem; } .actions { display:flex; gap:.45rem; flex-wrap:wrap; margin-top:.75rem; } .actions button { padding:.55rem .7rem; font-size:.82rem; }",
    ".recommendation { border-left: 4px solid var(--accent); padding-left: .85rem; }",
    "@media (min-width: 860px) { .workspace { grid-template-columns: 360px 1fr; align-items:start; } .metrics { grid-template-columns: repeat(4, minmax(0, 1fr)); } .board { grid-template-columns: repeat(5, minmax(0, 1fr)); } }",
    "===END FILE===",
    "===FILE: app.js===",
    "const STORAGE_KEY = 'forge-projectops-items';",
    "const seed = [",
    "  { id:'apk-durable', title:'Make APK builder durable', owner:'Virgil', type:'Chore', status:'Doing', priority:'High', effort:'Small', blocked:false, nextAction:'Keep the builder alive, health-checked, token-gated, and wired to Convex', dependency:'Tailscale Funnel host stays reachable', risk:'Export APK dies after reboot' },",
    "  { id:'projectops-real', title:'Make ProjectOps less toy', owner:'Virgil', type:'Feature', status:'Review', priority:'High', effort:'Small', blocked:false, nextAction:'Ship editable cards, filters, move/delete controls, and fact-based recommendations', dependency:'Template contract tests', risk:'Still feels like generic static cards' },",
    "  { id:'native-android', title:'Native Android rewrite', owner:'Cal', type:'Side quest', status:'Backlog', priority:'Parked', effort:'Large', blocked:false, nextAction:'Do not start until the WebView APK proof fails to satisfy installs/open/share', dependency:'Real product need', risk:'Good idea, wrong time. Park it.' }",
    "];",
    "let items = (JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') || seed).map((item, index) => ({ id: item.id || 'item-' + Date.now() + '-' + index, ...item }));",
    "let currentView = 'board';",
    "let statusFilter = 'all';",
    "const metricsEl = document.querySelector('#metrics');",
    "const viewEl = document.querySelector('#view');",
    "const form = document.querySelector('#work-item-form');",
    "const statusFilterEl = document.querySelector('#status-filter');",
    "function save() { localStorage.setItem('forge-projectops-items', JSON.stringify(items)); }",
    "function esc(value) { return String(value || '').replace(/[&<>\"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c])); }",
    "function isBlocked(item) { return item.blocked === true || item.blocked === 'on'; }",
    "function statusClass(item) { if (isBlocked(item)) return 'blocked'; if (item.status === 'Done') return 'done'; if (item.priority === 'Parked') return 'parked'; if (item.type === 'Side quest') return 'side'; return ''; }",
    "function visibleItems() { return statusFilter === 'all' ? items : items.filter(i => i.status === statusFilter); }",
    "function renderMetrics() {",
    "  const blocked = items.filter(isBlocked).length;",
    "  const sideQuests = detectSideQuests().length;",
    "  metricsEl.innerHTML = [['Items', items.length], ['Blocked', blocked], ['Side quests', sideQuests], ['Owners', new Set(items.map(i => i.owner)).size]]",
    "    .map(([label, value]) => '<div class=\"metric\"><strong>' + value + '</strong>' + label + '</div>').join('');",
    "}",
    "function renderItem(item) {",
    "  const actions = '<div class=\"actions\"><button type=\"button\" data-action=\"edit\" data-id=\"' + esc(item.id) + '\">Edit</button><button type=\"button\" data-action=\"move\" data-id=\"' + esc(item.id) + '\">Move status</button><button type=\"button\" data-action=\"delete\" data-id=\"' + esc(item.id) + '\">Delete</button></div>';",
    "  return '<article class=\"item\"><div class=\"item-head\"><strong>' + esc(item.title) + '</strong><span class=\"pill ' + statusClass(item) + '\">' + esc(isBlocked(item) ? 'Blocked' : item.priority) + '</span></div><p>' + esc(item.nextAction) + '</p><div class=\"meta\">' + esc(item.type) + ' · ' + esc(item.effort) + ' · Owner: ' + esc(item.owner) + ' · Status: ' + esc(item.status) + '</div><div class=\"meta\">Dependencies: ' + esc(item.dependency || 'none') + '</div>' + (item.risk ? '<div class=\"meta\">Risk: ' + esc(item.risk) + '</div>' : '') + actions + '</article>';",
    "}",
    "function renderBoard() {",
    "  const statuses = ['Backlog', 'Ready', 'Doing', 'Review', 'Done'];",
    "  const source = visibleItems();",
    "  viewEl.innerHTML = '<h2>Kanban board</h2><p>Software delivery beats fake construction scheduling here.</p><section class=\"board\">' + statuses.map(status => '<section class=\"lane\"><h3>' + status + '</h3>' + (source.filter(i => i.status === status).map(renderItem).join('') || '<p>No work.</p>') + '</section>').join('') + '</section>';",
    "}",
    "function renderBacklog() {",
    "  const ordered = [...visibleItems()].sort((a,b) => ['High','Medium','Low','Parked'].indexOf(a.priority) - ['High','Medium','Low','Parked'].indexOf(b.priority));",
    "  viewEl.innerHTML = '<h2>Backlog</h2><p>Prioritized work, including parked side quest candidates.</p>' + ordered.map(renderItem).join('');",
    "}",
    "function renderSprintFocus() {",
    "  const focus = visibleItems().filter(i => ['Doing','Review','Ready'].includes(i.status) && i.priority !== 'Parked');",
    "  viewEl.innerHTML = '<h2>Sprint focus</h2><p>This week: do fewer things, finish more things.</p>' + (focus.map(renderItem).join('') || '<p>No focused work selected.</p>');",
    "}",
    "function renderRisks() {",
    "  const risky = visibleItems().filter(i => isBlocked(i) || i.risk || i.dependency);",
    "  viewEl.innerHTML = '<h2>Risks & blockers</h2><p>Lightweight dependency/risk panel, not a full P6 clone.</p>' + risky.map(renderItem).join('');",
    "}",
    "function detectSideQuests() { return visibleItems().filter(i => i.type === 'Side quest' || i.priority === 'Parked' || /rewrite|native|platform|framework/i.test(i.title + ' ' + i.nextAction)); }",
    "function sideQuestWarning(item) { return 'Side-quest warning: ' + item.title + ' is ' + item.effort + ' effort, priority ' + item.priority + ', dependency: ' + (item.dependency || 'none') + '. ' + (item.risk || 'Park unless it unblocks current delivery.'); }",
    "function recommendNextTask() {",
    "  const unblocked = items.filter(i => !isBlocked(i) && i.priority === 'High' && i.status !== 'Done').sort((a,b) => ['Small','Medium','Large'].indexOf(a.effort) - ['Small','Medium','Large'].indexOf(b.effort));",
    "  return unblocked[0] || items.find(i => !isBlocked(i) && i.status !== 'Done') || null;",
    "}",
    "function recommendationRationale(item) { if (!item) return ''; return 'Recommendation rationale: ' + item.title + ' is ' + item.priority + ' priority, ' + item.effort + ' effort, status ' + item.status + ', owner ' + item.owner + '. Next action: ' + item.nextAction; }",
    "function renderPm() {",
    "  const next = recommendNextTask();",
    "  const sides = detectSideQuests();",
    "  viewEl.innerHTML = '<h2>AI project manager</h2><section class=\"pm-card recommendation\"><h3>Recommended next task</h3>' + (next ? '<p>' + esc(recommendationRationale(next)) + '</p>' + renderItem(next) : '<p>Nothing obvious. Weird, but possible.</p>') + '</section><section class=\"pm-card\"><h3>Side quest detector</h3>' + (sides.length ? sides.map(i => '<p>' + esc(sideQuestWarning(i)) + '</p>' + renderItem(i)).join('') : '<p>No obvious side quests.</p>') + '</section>';",
    "}",
    "function render() { renderMetrics(); if (currentView === 'board') renderBoard(); if (currentView === 'backlog') renderBacklog(); if (currentView === 'sprint') renderSprintFocus(); if (currentView === 'risks') renderRisks(); if (currentView === 'pm') renderPm(); }",
    "function addWorkItem(data) {",
    "  data.blocked = data.blocked === 'on';",
    "  data.id = data.id || 'item-' + Date.now();",
    "  const existing = items.findIndex(i => i.id === data.id || i.title.toLowerCase() === data.title.toLowerCase());",
    "  if (existing >= 0) items[existing] = data; else items.unshift(data);",
    "  save(); render();",
    "}",
    "function editWorkItem(id) { const item = items.find(i => i.id === id); if (!item) return; Object.entries(item).forEach(([key, value]) => { if (form.elements[key]) { if (form.elements[key].type === 'checkbox') form.elements[key].checked = !!value; else form.elements[key].value = value; } }); form.scrollIntoView({ behavior:'smooth', block:'start' }); }",
    "function deleteWorkItem(id) { items = items.filter(i => i.id !== id); save(); render(); }",
    "function moveWorkItem(id) { const statuses = ['Backlog','Ready','Doing','Review','Done']; const item = items.find(i => i.id === id); if (!item) return; item.status = statuses[(statuses.indexOf(item.status) + 1) % statuses.length]; save(); render(); }",
    "form.addEventListener('submit', event => { event.preventDefault(); addWorkItem(Object.fromEntries(new FormData(form))); form.reset(); });",
    "statusFilterEl.addEventListener('change', () => { statusFilter = statusFilterEl.value; render(); });",
    "document.querySelector('#clear-done').addEventListener('click', () => { items = items.filter(i => i.status !== 'Done'); save(); render(); });",
    "viewEl.addEventListener('click', event => { const btn = event.target.closest('button[data-action]'); if (!btn) return; if (btn.dataset.action === 'edit') editWorkItem(btn.dataset.id); if (btn.dataset.action === 'delete') deleteWorkItem(btn.dataset.id); if (btn.dataset.action === 'move') moveWorkItem(btn.dataset.id); });",
    "document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => { document.querySelectorAll('.tab').forEach(b => b.classList.remove('active')); btn.classList.add('active'); currentView = btn.dataset.view; render(); }));",
    "render();",
    "===END FILE===",
  ].join("\n");
}

export function renderPocTemplate(user: string): string {
  const prompt = user.replace(/^Build this web app:\s*/i, "").trim() || "a useful tiny app";
  if (isProjectOpsPrompt(prompt)) return renderProjectOpsTemplate();
  const safePrompt = escapeHtml(prompt);
  const appName = titleFromPrompt(prompt);
  return `APP_NAME: ${appName}
APP_EMOJI: ⚡
SUMMARY: Zero-cost POC template generated from the prompt.
===FILE: index.html===
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${escapeHtml(appName)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700;900&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <main class="shell">
    <section class="hero">
      <p class="eyebrow">Forge zero-cost POC</p>
      <h1>${escapeHtml(appName)}</h1>
      <p class="prompt">${safePrompt}</p>
      <div class="actions">
        <button id="primary">Try it</button>
        <button id="save">Save note</button>
      </div>
    </section>
    <section class="panel">
      <h2>What works</h2>
      <ul id="checks">
        <li>Convex created the project</li>
        <li>Daytona hosted this preview</li>
        <li>Frontend JS is interactive</li>
      </ul>
      <textarea id="note" placeholder="Type a quick note…"></textarea>
      <p id="status">Ready.</p>
    </section>
  </main>
  <script src="app.js"></script>
</body>
</html>
===END FILE===
===FILE: style.css===
:root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: radial-gradient(circle at top left, #7c3aed55, transparent 32rem), linear-gradient(135deg, #050816, #101827 55%, #020617); color: white; }
.shell { min-height: 100vh; display: grid; gap: 1rem; padding: max(2rem, env(safe-area-inset-top)) 1rem 2rem; align-content: center; max-width: 920px; margin: 0 auto; }
.hero, .panel { border: 1px solid #ffffff1f; background: #ffffff12; border-radius: 28px; padding: 1.25rem; box-shadow: 0 24px 80px #0008; backdrop-filter: blur(18px); }
.eyebrow { color: #a78bfa; text-transform: uppercase; letter-spacing: .12em; font-size: .75rem; font-weight: 900; }
h1 { font-size: clamp(2.3rem, 12vw, 5.5rem); line-height: .88; margin: .25rem 0 1rem; letter-spacing: -.08em; }
.prompt { color: #dbeafe; font-size: 1.1rem; line-height: 1.5; }
.actions { display: flex; gap: .75rem; flex-wrap: wrap; margin-top: 1.25rem; }
button { border: 0; border-radius: 999px; padding: .95rem 1.2rem; font-weight: 900; color: white; background: #7c3aed; box-shadow: 0 12px 30px #7c3aed66; }
button:last-child { background: #ffffff1f; box-shadow: none; }
button:active { transform: translateY(1px) scale(.99); }
.panel h2 { margin-top: 0; }
li { margin: .6rem 0; color: #dcfce7; }
textarea { width: 100%; min-height: 110px; border: 1px solid #ffffff24; border-radius: 18px; background: #02061799; color: white; padding: 1rem; font: inherit; resize: vertical; }
#status { color: #bae6fd; font-weight: 700; }
@media (min-width: 760px) { .shell { grid-template-columns: 1.2fr .8fr; } }
===END FILE===
===FILE: app.js===
const statusEl = document.querySelector('#status');
const noteEl = document.querySelector('#note');
document.querySelector('#primary').addEventListener('click', () => {
  const count = Number(localStorage.getItem('forge-poc-clicks') || '0') + 1;
  localStorage.setItem('forge-poc-clicks', String(count));
  statusEl.textContent = 'Button works. Click count: ' + count + '.';
});
document.querySelector('#save').addEventListener('click', () => {
  localStorage.setItem('forge-poc-note', noteEl.value.trim());
  statusEl.textContent = noteEl.value.trim() ? 'Saved locally.' : 'Nothing to save yet.';
});
noteEl.value = localStorage.getItem('forge-poc-note') || '';
===END FILE===`;
}

async function callClaude(system: string, user: string, model: string): Promise<string> {
  if (builderProvider() === "poc-template") return renderPocTemplate(user);

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set on the Convex deployment");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      stream: true,
      system,
      messages: [{ role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(540_000),
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new Error(`Claude API error (${res.status}): ${body.slice(0, 300)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const event = JSON.parse(payload);
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          text += event.delta.text;
        }
        if (event.type === "error") {
          throw new Error(`Claude stream error: ${event.error?.message ?? "unknown"}`);
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Claude stream error")) throw err;
      }
    }
  }
  if (!text.trim()) throw new Error("Claude returned an empty response");
  return text;
}

type GeneratedApp = {
  name: string;
  emoji: string;
  summary: string;
  files: { path: string; content: string }[];
};

function sanitizeSwiftName(path: string): string {
  const base = path.split("/").pop() ?? "File.swift";
  let stem = base.replace(/\.swift$/i, "").replace(/[^A-Za-z0-9_]/g, "");
  if (!stem) stem = "File";
  return `${stem}.swift`;
}

function parseGeneration(text: string, platform: "web" | "mobile"): GeneratedApp {
  const name = /^APP_NAME:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? "Untitled App";
  const emoji = /^APP_EMOJI:\s*(\S+)/m.exec(text)?.[1]?.trim() ?? "✨";
  const summary = /^SUMMARY:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? "";
  let files: { path: string; content: string }[] = [];
  const re = /===FILE:\s*([^=\n]+?)\s*===\n([\s\S]*?)\n?===END FILE===/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const path = match[1].trim().replace(/^\/+/, "");
    if (!path || path.includes("..")) continue;
    files.push({ path, content: match[2] });
  }
  if (platform === "mobile") {
    const seen = new Set<string>();
    files = files
      .filter((f) => f.path.toLowerCase().endsWith(".swift"))
      .map((f) => ({ path: sanitizeSwiftName(f.path), content: f.content }))
      .filter((f) => (seen.has(f.path) ? false : (seen.add(f.path), true)));
    if (files.length === 0) {
      throw new Error("The generated app has no Swift files — try again");
    }
    if (!files.some((f) => f.content.includes("@main"))) {
      throw new Error("The generated app is missing an @main entry point — try again");
    }
  } else if (!files.some((f) => f.path === "index.html")) {
    throw new Error("The generated app is missing index.html — try again");
  }
  return { name: name.slice(0, 30), emoji, summary, files };
}

function buildUserPrompt(prompt: string, platform: "web" | "mobile"): string {
  return platform === "mobile" ? `Build this iOS app: ${prompt}` : `Build this web app: ${prompt}`;
}

function editUserPrompt(
  files: { path: string; content: string }[],
  conversation: { role: string; content: string }[],
  request: string
): string {
  const fileBlock = files
    .map((f) => `===FILE: ${f.path}===\n${f.content}\n===END FILE===`)
    .join("\n");
  const convo = conversation
    .filter((m) => m.role === "user" || m.role === "agent")
    .slice(-10)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");
  return `CURRENT FILES:\n${fileBlock}\n\nRECENT CONVERSATION:\n${convo}\n\nCHANGE REQUEST: ${request}`;
}

// ---------------------------------------------------------------------------
// Status plumbing
// ---------------------------------------------------------------------------

async function setStatus(
  ctx: ActionCtx,
  projectId: Id<"projects">,
  status: string,
  statusDetail: string
): Promise<void> {
  await ctx.runMutation(internal.projects.update, { id: projectId, status, statusDetail });
}

async function log(
  ctx: ActionCtx,
  projectId: Id<"projects">,
  content: string,
  role = "log"
): Promise<void> {
  await ctx.runMutation(internal.messages.log, { projectId, role, content });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Web actions (Daytona)
// ---------------------------------------------------------------------------

export const build = internalAction({
  args: { projectId: v.id("projects") },
  returns: v.null(),
  handler: async (ctx, { projectId }) => {
    const project = await ctx.runQuery(internal.projects.getInternal, { id: projectId });
    if (!project) return null;
    try {
      if (project.sandboxId) {
        await daytona(`/sandbox/${project.sandboxId}`, { method: "DELETE" }).catch(() => {});
      }

      await setStatus(ctx, projectId, "generating", "Claude is designing your app");
      await log(ctx, projectId, "🧠 Claude is writing your app…");
      const raw = await callClaude(GENERATE_SYSTEM + aiSkill("web"), buildUserPrompt(project.prompt, "web"), resolveModel(project.model));
      const app = parseGeneration(raw, "web");
      await ctx.runMutation(internal.projects.update, {
        id: projectId,
        name: app.name,
        emoji: app.emoji,
      });
      await ctx.runMutation(internal.files.saveAll, { projectId, files: app.files });
      await log(
        ctx,
        projectId,
        `📁 Generated ${app.files.length} file${app.files.length === 1 ? "" : "s"}: ${app.files
          .map((f) => f.path)
          .join(", ")}`
      );

      await setStatus(ctx, projectId, "sandbox", "Spinning up a cloud sandbox");
      await log(ctx, projectId, "📦 Creating a Daytona sandbox…");
      const sandboxId = await createSandbox();
      await ctx.runMutation(internal.projects.update, { id: projectId, sandboxId });

      await setStatus(ctx, projectId, "uploading", "Uploading your code");
      await log(ctx, projectId, "⬆️ Uploading files to the sandbox…");
      await uploadAppFiles(sandboxId, app.files);

      await setStatus(ctx, projectId, "starting", "Starting the web server");
      await log(ctx, projectId, "🚀 Starting the web server…");
      await startStaticServer(sandboxId);
      const previewUrl = await getPreviewUrl(sandboxId);
      await waitForPreview(previewUrl);

      await ctx.runMutation(internal.projects.update, {
        id: projectId,
        status: "live",
        statusDetail: "Live",
        previewUrl,
        version: project.version + 1,
        clearError: true,
      });
      await log(
        ctx,
        projectId,
        app.summary ? `✅ ${app.name} is live! ${app.summary}` : `✅ ${app.name} is live!`,
        "agent"
      );
    } catch (err) {
      await ctx.runMutation(internal.projects.update, {
        id: projectId,
        status: "error",
        statusDetail: "Build failed",
        error: errorMessage(err),
      });
      await log(ctx, projectId, `❌ Build failed: ${errorMessage(err)}`, "agent");
    }
    return null;
  },
});

export const edit = internalAction({
  args: { projectId: v.id("projects") },
  returns: v.null(),
  handler: async (ctx, { projectId }) => {
    const project = await ctx.runQuery(internal.projects.getInternal, { id: projectId });
    if (!project) return null;
    try {
      const files = await ctx.runQuery(internal.files.getAll, { projectId });
      if (files.length === 0) throw new Error("No files yet — rebuild the app first");
      const conversation = await ctx.runQuery(internal.messages.recent, {
        projectId,
        limit: 30,
      });
      const request =
        [...conversation].reverse().find((m) => m.role === "user")?.content ?? project.prompt;

      await setStatus(ctx, projectId, "updating", "Claude is applying your changes");
      await log(ctx, projectId, "🛠️ Claude is updating your app…");
      const raw = await callClaude(
        EDIT_SYSTEM + aiSkill("web"),
        editUserPrompt(
          files.map((f) => ({ path: f.path, content: f.content })),
          conversation,
          request
        ),
        resolveModel(project.model)
      );
      const app = parseGeneration(raw, "web");
      await ctx.runMutation(internal.files.saveAll, { projectId, files: app.files });
      if (app.name !== project.name || app.emoji !== project.emoji) {
        await ctx.runMutation(internal.projects.update, {
          id: projectId,
          name: app.name,
          emoji: app.emoji,
        });
      }

      let sandboxId = project.sandboxId;
      const existing = sandboxId ? await getSandbox(sandboxId).catch(() => null) : null;
      if (!existing || ["destroyed", "error", "build_failed"].includes(existing.state)) {
        await setStatus(ctx, projectId, "sandbox", "Spinning up a fresh sandbox");
        await log(ctx, projectId, "📦 Creating a Daytona sandbox…");
        sandboxId = await createSandbox();
        await ctx.runMutation(internal.projects.update, { id: projectId, sandboxId });
      } else if (existing.state !== "started") {
        await setStatus(ctx, projectId, "waking", "Waking the sandbox");
        await log(ctx, projectId, "☀️ Waking the sandbox…");
        await startSandbox(sandboxId!);
      }

      await setStatus(ctx, projectId, "uploading", "Uploading changes");
      await log(ctx, projectId, "⬆️ Uploading changes…");
      await uploadAppFiles(sandboxId!, app.files);
      await startStaticServer(sandboxId!);
      const previewUrl = await getPreviewUrl(sandboxId!);

      await ctx.runMutation(internal.projects.update, {
        id: projectId,
        status: "live",
        statusDetail: "Live",
        previewUrl,
        version: project.version + 1,
        clearError: true,
      });
      await log(ctx, projectId, app.summary ? `✅ Updated! ${app.summary}` : "✅ Updated!", "agent");
    } catch (err) {
      const fallbackLive = Boolean(project.previewUrl);
      await ctx.runMutation(internal.projects.update, {
        id: projectId,
        status: fallbackLive ? "live" : "error",
        statusDetail: fallbackLive ? "Live (last update failed)" : "Update failed",
        error: errorMessage(err),
      });
      await log(ctx, projectId, `❌ Update failed: ${errorMessage(err)}`, "agent");
    }
    return null;
  },
});

export const ensureRunning = internalAction({
  args: { projectId: v.id("projects") },
  returns: v.null(),
  handler: async (ctx, { projectId }) => {
    const project = await ctx.runQuery(internal.projects.getInternal, { id: projectId });
    if (!project || project.status !== "live") return null;

    // Mobile: re-mint the tokenized simulator preview if it stopped serving.
    if (project.platform === "mobile") {
      if (!project.buildJobId || !project.previewUrl) return null;
      try {
        const probe = await fetch(project.previewUrl, {
          signal: AbortSignal.timeout(8_000),
        });
        if (probe.ok) return null;
      } catch {
        // unreachable — fall through and re-mint
      }
      try {
        const preview = await mintSimPreview(projectId, project.buildJobId);
        if (preview.previewUrl && preview.previewUrl !== project.previewUrl) {
          await ctx.runMutation(internal.projects.update, {
            id: projectId,
            previewUrl: preview.previewUrl,
            simBuildId: preview.simBuildId,
            version: project.version + 1,
          });
        }
      } catch {
        // keep the existing preview URL
      }
      return null;
    }

    if (!project.sandboxId) return null;
    try {
      const sb = await getSandbox(project.sandboxId);
      if (sb.state === "started") {
        await startStaticServer(project.sandboxId);
        return null;
      }
      if (["stopped", "stopping", "archived"].includes(sb.state)) {
        await ctx.runMutation(internal.projects.update, {
          id: projectId,
          status: "waking",
          statusDetail: "Waking your app",
        });
        if (sb.state === "stopping") {
          await waitForSandboxState(project.sandboxId, "stopped", 60_000);
        }
        await startSandbox(project.sandboxId);
        await startStaticServer(project.sandboxId);
        const previewUrl = await getPreviewUrl(project.sandboxId);
        await ctx.runMutation(internal.projects.update, {
          id: projectId,
          status: "live",
          statusDetail: "Live",
          previewUrl,
          version: project.version + 1,
        });
        await log(ctx, projectId, "☀️ Woke your app back up");
      }
    } catch {
      await ctx.runMutation(internal.projects.update, {
        id: projectId,
        status: "live",
        statusDetail: "Preview may be sleeping — try again",
      });
    }
    return null;
  },
});

type AndroidApkBuilderResponse = {
  downloadUrl?: string;
  apkUrl?: string;
  artifactUrl?: string;
  url?: string;
};

async function callAndroidApkBuilder(spec: {
  projectId: string;
  appName: string;
  packageId: string;
  previewUrl: string;
  artifactName: string;
}): Promise<string> {
  const endpoint = process.env.FORGE_ANDROID_APK_BUILDER_URL;
  if (!endpoint) {
    throw new Error("FORGE_ANDROID_APK_BUILDER_URL is not set on the Convex deployment");
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = process.env.FORGE_ANDROID_APK_BUILDER_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(spec),
    signal: AbortSignal.timeout(540_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Android APK builder failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as AndroidApkBuilderResponse;
  const url = data.downloadUrl ?? data.apkUrl ?? data.artifactUrl ?? data.url;
  if (!url) throw new Error("Android APK builder response did not include a download URL");
  return url;
}

export const buildAndroidApk = internalAction({
  args: { projectId: v.id("projects") },
  returns: v.null(),
  handler: async (ctx, { projectId }) => {
    const project = await ctx.runQuery(internal.projects.getInternal, { id: projectId });
    if (!project) return null;
    try {
      if (project.platform === "mobile") {
        throw new Error("Android APK export is only available for web projects right now");
      }
      if (!project.previewUrl) {
        throw new Error("No live preview URL yet — build the web app first");
      }

      let previewUrl = project.previewUrl;
      if (project.sandboxId) {
        const sb = await getSandbox(project.sandboxId).catch(() => null);
        if (!sb || ["destroyed", "error", "build_failed"].includes(sb.state)) {
          throw new Error("The Daytona sandbox is gone — rebuild the web app first");
        }
        if (sb.state !== "started") {
          await setStatus(ctx, projectId, "waking", "Waking your app before APK export");
          await log(ctx, projectId, "☀️ Waking the sandbox before Android export…");
          if (sb.state === "stopping") {
            await waitForSandboxState(project.sandboxId, "stopped", 60_000);
          }
          await startSandbox(project.sandboxId);
        }
        await startStaticServer(project.sandboxId);
        previewUrl = await getPreviewUrl(project.sandboxId);
        if (previewUrl !== project.previewUrl) {
          await ctx.runMutation(internal.projects.update, { id: projectId, previewUrl });
        }
      }
      await waitForPreview(previewUrl);

      const spec = androidApkBuildSpec({
        projectId,
        name: project.name,
        previewUrl,
      });
      await setStatus(ctx, projectId, "building", "Building Android APK");
      await log(ctx, projectId, `📱 Building Android APK (${spec.packageId})…`);
      const apkUrl = await callAndroidApkBuilder({ projectId, ...spec });
      await ctx.runMutation(internal.projects.update, {
        id: projectId,
        status: "live",
        statusDetail: "Live",
        installUrl: apkUrl,
        clearError: true,
      });
      await log(ctx, projectId, `✅ Android APK is ready: ${apkUrl}`, "agent");
    } catch (err) {
      await ctx.runMutation(internal.projects.update, {
        id: projectId,
        status: project.previewUrl ? "live" : "error",
        statusDetail: project.previewUrl ? "Live (Android APK failed)" : "Android APK failed",
        error: errorMessage(err),
      });
      await log(ctx, projectId, `❌ Android APK failed: ${errorMessage(err)}`, "agent");
    }
    return null;
  },
});

export const destroySandbox = internalAction({
  args: { sandboxId: v.string() },
  returns: v.null(),
  handler: async (_ctx, { sandboxId }) => {
    await daytona(`/sandbox/${sandboxId}`, { method: "DELETE" }, 60_000).catch(() => {});
    return null;
  },
});

// ---------------------------------------------------------------------------
// Mobile actions (Chorus)
// ---------------------------------------------------------------------------

export const buildMobile = internalAction({
  args: { projectId: v.id("projects") },
  returns: v.null(),
  handler: async (ctx, { projectId }) => {
    const project = await ctx.runQuery(internal.projects.getInternal, { id: projectId });
    if (!project) return null;
    try {
      await setStatus(ctx, projectId, "generating", "Claude is designing your iOS app");
      await log(ctx, projectId, "🧠 Claude is writing your iOS app in Swift…");
      const raw = await callClaude(
        MOBILE_GENERATE_SYSTEM + aiSkill("mobile"),
        buildUserPrompt(project.prompt, "mobile"),
        resolveModel(project.model)
      );
      const app = parseGeneration(raw, "mobile");
      await ctx.runMutation(internal.projects.update, {
        id: projectId,
        name: app.name,
        emoji: app.emoji,
      });
      await ctx.runMutation(internal.files.saveAll, { projectId, files: app.files });
      await log(
        ctx,
        projectId,
        `📁 Generated ${app.files.length} Swift file${app.files.length === 1 ? "" : "s"}: ${app.files
          .map((f) => f.path)
          .join(", ")}`
      );
      await startMobileBuild(ctx, projectId, app.name, app.summary, app.files, false);
    } catch (err) {
      await ctx.runMutation(internal.projects.update, {
        id: projectId,
        status: "error",
        statusDetail: "Build failed",
        error: errorMessage(err),
      });
      await log(ctx, projectId, `❌ Build failed: ${errorMessage(err)}`, "agent");
    }
    return null;
  },
});

export const editMobile = internalAction({
  args: { projectId: v.id("projects") },
  returns: v.null(),
  handler: async (ctx, { projectId }) => {
    const project = await ctx.runQuery(internal.projects.getInternal, { id: projectId });
    if (!project) return null;
    try {
      const files = await ctx.runQuery(internal.files.getAll, { projectId });
      if (files.length === 0) throw new Error("No files yet — rebuild the app first");
      const conversation = await ctx.runQuery(internal.messages.recent, {
        projectId,
        limit: 30,
      });
      const request =
        [...conversation].reverse().find((m) => m.role === "user")?.content ?? project.prompt;

      await setStatus(ctx, projectId, "updating", "Claude is applying your changes");
      await log(ctx, projectId, "🛠️ Claude is updating your iOS app…");
      const raw = await callClaude(
        MOBILE_EDIT_SYSTEM + aiSkill("mobile"),
        editUserPrompt(
          files.map((f) => ({ path: f.path, content: f.content })),
          conversation,
          request
        ),
        resolveModel(project.model)
      );
      const app = parseGeneration(raw, "mobile");
      await ctx.runMutation(internal.files.saveAll, { projectId, files: app.files });
      if (app.name !== project.name || app.emoji !== project.emoji) {
        await ctx.runMutation(internal.projects.update, {
          id: projectId,
          name: app.name,
          emoji: app.emoji,
        });
      }
      await startMobileBuild(ctx, projectId, app.name, app.summary, app.files, true);
    } catch (err) {
      const fallbackLive = Boolean(project.previewUrl);
      await ctx.runMutation(internal.projects.update, {
        id: projectId,
        status: fallbackLive ? "live" : "error",
        statusDetail: fallbackLive ? "Live (last update failed)" : "Update failed",
        error: errorMessage(err),
      });
      await log(ctx, projectId, `❌ Update failed: ${errorMessage(err)}`, "agent");
    }
    return null;
  },
});

export const pollMobileBuild = internalAction({
  args: {
    projectId: v.id("projects"),
    buildJobId: v.string(),
    attempts: v.number(),
    isEdit: v.boolean(),
    summary: v.string(),
    repairCount: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, { projectId, buildJobId, attempts, isEdit, summary, repairCount }) => {
    const repairs = repairCount ?? 0;
    const project = await ctx.runQuery(internal.projects.getInternal, { id: projectId });
    // Bail on stale polls (project deleted or superseded by a newer build).
    if (!project || project.buildJobId !== buildJobId) return null;
    try {
      const job = await chorusJson<{ state: string; error: string | null; appUrl: string | null }>(
        `/api/build-jobs/${buildJobId}`
      );
      if (job.state === "built") {
        const preview = await mintSimPreview(projectId, buildJobId);
        await ctx.runMutation(internal.projects.update, {
          id: projectId,
          status: "live",
          statusDetail: "Live",
          previewUrl: preview.previewUrl,
          simBuildId: preview.simBuildId,
          appUrl: job.appUrl ?? undefined,
          version: project.version + 1,
          clearError: true,
        });
        const headline = isEdit
          ? summary
            ? `✅ Updated! ${summary}`
            : "✅ Updated!"
          : summary
            ? `✅ ${project.name} is live! ${summary}`
            : `✅ ${project.name} is live!`;
        await log(
          ctx,
          projectId,
          `${headline}\n\n📲 Want it on your iPhone? Ask me for the download link.`,
          "agent"
        );
        return null;
      }
      if (job.state === "failed") {
        const errors = await extractBuildErrors(buildJobId);
        // Self-heal: feed compiler errors back to Claude and rebuild.
        if (repairs < 2 && errors.length > 0) {
          await setStatus(
            ctx,
            projectId,
            "generating",
            "Build hit compile errors — Claude is fixing them"
          );
          await log(
            ctx,
            projectId,
            `🔧 Compile ${errors.length === 1 ? "error" : "errors"} found — Claude is fixing ${errors.length === 1 ? "it" : "them"}…`
          );
          const files = await ctx.runQuery(internal.files.getAll, { projectId });
          const raw = await callClaude(
            MOBILE_FIX_SYSTEM + aiSkill("mobile"),
            fixUserPrompt(
              files.map((f) => ({ path: f.path, content: f.content })),
              errors.slice(0, 8)
            ),
            resolveModel(project.model)
          );
          const app = parseGeneration(raw, "mobile");
          await ctx.runMutation(internal.files.saveAll, { projectId, files: app.files });
          await startMobileBuild(
            ctx,
            projectId,
            project.name,
            summary || app.summary,
            app.files,
            isEdit,
            repairs + 1
          );
          return null;
        }
        const detail =
          errors.slice(0, 2).join(" · ").slice(0, 400) ||
          job.error?.slice(0, 300) ||
          "Cloud build failed — try rebuilding";
        await ctx.runMutation(internal.projects.update, {
          id: projectId,
          status: "error",
          statusDetail: "Cloud build failed",
          error: detail,
        });
        await log(ctx, projectId, `❌ Cloud build failed: ${detail}`, "agent");
        return null;
      }
      // Still building.
      if (attempts >= 60) {
        await ctx.runMutation(internal.projects.update, {
          id: projectId,
          status: "error",
          statusDetail: "Cloud build timed out",
          error: "The cloud build did not finish in 15 minutes — try rebuilding",
        });
        await log(ctx, projectId, "❌ The cloud build timed out — try rebuilding.", "agent");
        return null;
      }
      if (attempts === 20) {
        await setStatus(
          ctx,
          projectId,
          "building",
          "Still compiling — the cloud queue can add a few minutes"
        );
      }
      await ctx.scheduler.runAfter(15_000, internal.builder.pollMobileBuild, {
        projectId,
        buildJobId,
        attempts: attempts + 1,
        isEdit,
        summary,
        repairCount: repairs,
      });
    } catch (err) {
      if (attempts >= 60) {
        await ctx.runMutation(internal.projects.update, {
          id: projectId,
          status: "error",
          statusDetail: "Cloud build failed",
          error: errorMessage(err),
        });
        await log(ctx, projectId, `❌ Cloud build failed: ${errorMessage(err)}`, "agent");
        return null;
      }
      await ctx.scheduler.runAfter(20_000, internal.builder.pollMobileBuild, {
        projectId,
        buildJobId,
        attempts: attempts + 2,
        isEdit,
        summary,
        repairCount: repairs,
      });
    }
    return null;
  },
});

export const provideInstallLink = internalAction({
  args: { projectId: v.id("projects") },
  returns: v.null(),
  handler: async (ctx, { projectId }) => {
    const project = await ctx.runQuery(internal.projects.getInternal, { id: projectId });
    if (!project) return null;
    try {
      if (!project.appUrl) {
        await ctx.runMutation(internal.projects.update, {
          id: projectId,
          status: "live",
          statusDetail: "Live",
        });
        await log(
          ctx,
          projectId,
          "❌ I don't have a finished cloud build to sign yet — rebuild the app first, then ask again.",
          "agent"
        );
        return null;
      }
      await setStatus(ctx, projectId, "signing", "Signing your app for your iPhone");
      await log(ctx, projectId, "🔏 Signing your app for device install…");
      const res = await chorus(
        "/api/sign",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: chorusUserId(),
            appUrl: project.appUrl,
            projectId: `forge-${projectId}`,
          }),
        },
        90_000
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        await ctx.runMutation(internal.projects.update, {
          id: projectId,
          status: "live",
          statusDetail: "Live",
        });
        if (/authenticate|No saved Apple|User not found|session/i.test(body)) {
          await postLoginLink(ctx, projectId);
        } else {
          await log(ctx, projectId, `❌ Signing failed: ${body.slice(0, 250)}`, "agent");
        }
        return null;
      }
      const sign = (await res.json()) as { buildId: string; installUrl: string };
      await ctx.runMutation(internal.projects.update, {
        id: projectId,
        signBuildId: sign.buildId,
      });
      await ctx.scheduler.runAfter(10_000, internal.builder.pollSign, {
        projectId,
        signBuildId: sign.buildId,
        attempts: 0,
      });
    } catch (err) {
      await ctx.runMutation(internal.projects.update, {
        id: projectId,
        status: "live",
        statusDetail: "Live",
      });
      await log(ctx, projectId, `❌ Signing failed: ${errorMessage(err)}`, "agent");
    }
    return null;
  },
});

export const pollSign = internalAction({
  args: {
    projectId: v.id("projects"),
    signBuildId: v.string(),
    attempts: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { projectId, signBuildId, attempts }) => {
    const project = await ctx.runQuery(internal.projects.getInternal, { id: projectId });
    if (!project || project.signBuildId !== signBuildId) return null;
    const backToLive = async (detail = "Live") => {
      await ctx.runMutation(internal.projects.update, {
        id: projectId,
        status: "live",
        statusDetail: detail,
      });
    };
    try {
      const build = await chorusJson<{
        state: string;
        error: string | null;
        installUrl: string | null;
      }>(`/api/builds/${signBuildId}`);
      if (build.state === "signed") {
        const installUrl = build.installUrl ?? `${chorusBase()}/install/${signBuildId}`;
        await ctx.runMutation(internal.projects.update, {
          id: projectId,
          status: "live",
          statusDetail: "Live",
          installUrl,
          clearError: true,
        });
        await log(
          ctx,
          projectId,
          `📲 Your app is signed and ready!\n\n[Install ${project.name} on your iPhone](${installUrl})\n\nOpen the link in Safari on your phone and tap Install. If iOS asks, approve it in Settings → General → VPN & Device Management.`,
          "agent"
        );
        return null;
      }
      if (build.state === "failed") {
        await backToLive();
        const error = build.error ?? "Unknown signing error";
        if (/No registered iOS devices/i.test(error)) {
          await log(
            ctx,
            projectId,
            `📱 Your iPhone isn't registered for signing yet.\n\n[Register this iPhone](${chorusBase()}/register/${chorusUserId()}) — open that link on your phone, install the profile, then ask me for the download link again.`,
            "agent"
          );
        } else if (/authenticate|No saved Apple|session|auth/i.test(error)) {
          await postLoginLink(ctx, projectId);
        } else {
          await log(ctx, projectId, `❌ Signing failed: ${error.slice(0, 250)}`, "agent");
        }
        return null;
      }
      // pending | signing
      if (attempts >= 36) {
        await backToLive();
        await log(
          ctx,
          projectId,
          "❌ Signing timed out — ask me for the download link again in a minute.",
          "agent"
        );
        return null;
      }
      await ctx.scheduler.runAfter(10_000, internal.builder.pollSign, {
        projectId,
        signBuildId,
        attempts: attempts + 1,
      });
    } catch (err) {
      if (attempts >= 36) {
        await backToLive();
        await log(ctx, projectId, `❌ Signing failed: ${errorMessage(err)}`, "agent");
        return null;
      }
      await ctx.scheduler.runAfter(15_000, internal.builder.pollSign, {
        projectId,
        signBuildId,
        attempts: attempts + 2,
      });
    }
    return null;
  },
});
