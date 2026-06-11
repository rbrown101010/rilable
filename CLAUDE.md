# Forge — agent setup guide

Forge is an open-source iOS app that builds **live web apps and native iOS apps from a
prompt** — a Lovable/Replit-mobile-style builder you run on your own accounts. SwiftUI front
end, Convex backend, Claude for code generation, Daytona cloud sandboxes for web apps, Chorus
cloud Xcode builds for iOS apps.

**If you are an AI coding agent (Claude Code etc.): your job is to get this running for the
user end-to-end.** Drive every step below yourself — run the commands, ask the user for keys at
the moments they're needed (with the exact URLs to get them), verify each stage before moving
on, and finish with the app running in the iOS Simulator. The user should never have to read
documentation.

## Architecture (30 seconds)

```
iOS app (SwiftUI, ios/)  ── convex-swift websocket ──►  Convex backend (backend/convex/)
  the user types a prompt          projects/messages/files tables, real-time
                                   "builder" node action orchestrates:
                                   ├─ Anthropic API — Claude writes the app code
                                   ├─ [web]    Daytona REST — public sandbox serves it
                                   ├─ [mobile] Chorus REST — cloud Xcode build + browser
                                   │           iPhone-simulator preview + OTA device installs
                                   ├─ OpenAI Whisper — voice input (optional)
                                   └─ Vercel AI Gateway proxy (convex/http.ts) — gives every
                                      generated app free AI features (optional)
```

## Prerequisites — verify before anything else

```bash
xcodebuild -version   # Xcode 16+ on macOS
node -v               # Node 18+
xcodegen --version    # brew install xcodegen
```

An iPhone Simulator (any iOS 17+ runtime) is enough; a physical iPhone is optional.

## Step 1 — Convex backend (free)

```bash
cd backend && npm install
npx convex dev --once --configure new
```

This opens a browser login (GitHub/Google, free tier is fine), creates a project, pushes the
functions, and writes `backend/.env.local` containing `CONVEX_URL` — you'll need that URL in
Step 3.

## Step 2 — API keys

Ask the user for these one at a time, then set each with
`npx convex env set NAME value` (run inside `backend/`):

| Env var | Get it at | Powers | Needed for |
|---|---|---|---|
| `RILABLE_ACCESS_TOKEN` | generate a long random string locally | single-user gate for app/backend calls | **Recommended before real keys** |
| `ANTHROPIC_API_KEY` | console.anthropic.com → Settings → API Keys | Claude writes the apps | **Required** |
| `DAYTONA_API_KEY` | app.daytona.io → Settings → API Keys | web-app sandboxes | Web builds |
| `CHORUS_API_KEY` | ios.chorus.com (Vibecode's iOS build service — install its CLI with `curl -fsSL https://ios.chorus.com/install.sh \| bash`, then `./build-ios-apps/ios-cli login`; the key starts with `chorus_`) | cloud Xcode builds + signing | Mobile builds |
| `CHORUS_USER_ID` | printed by the Chorus CLI after login (also in `~/.vibecode/ios/config.json` as `userId`) | device-install signing | Mobile installs |
| `OPENAI_API_KEY` | platform.openai.com → API keys | Whisper voice input | Optional |
| `VERCEL_AI_GATEWAY_KEY` | vercel.com dashboard → AI Gateway → API keys (starts `vck_`) | AI features inside generated apps | Optional |
| `FORGE_ANDROID_APK_BUILDER_URL` | your APK builder service `/build` URL | Android APK export for web projects | Optional |
| `FORGE_ANDROID_APK_BUILDER_TOKEN` | generate a long random string locally | protects APK builder calls | Recommended if APK builder is network-exposed |

Minimum viable setup: `RILABLE_ACCESS_TOKEN` + `ANTHROPIC_API_KEY` + `DAYTONA_API_KEY` (web builds only). Skip any
optional key the user doesn't want — the related feature degrades gracefully. Keep
`RILABLE_ALLOW_PUBLIC_AI_PROXY` unset unless the user explicitly accepts a public disposable demo proxy.

## Step 3 — iOS app

```bash
cp ios/AppConfig.example.swift ios/Sources/AppConfig.swift
# edit ios/Sources/AppConfig.swift:
#   convexDeploymentURL = the CONVEX_URL from backend/.env.local
#   accessToken         = the RILABLE_ACCESS_TOKEN you set on Convex
#   userName            = the user's first name (home-screen greeting)
```

Optionally edit `ios/project.yml`: set `PRODUCT_BUNDLE_IDENTIFIER` to a reverse-DNS id the
user owns and `DEVELOPMENT_TEAM` to their Apple team id (only needed for running on a physical
iPhone — simulator builds work with the defaults).

```bash
cd ios
xcodegen generate
xcodebuild -project Forge.xcodeproj -scheme Forge \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -derivedDataPath build CODE_SIGNING_ALLOWED=NO build
xcrun simctl boot "iPhone 17" 2>/dev/null; open -a Simulator
xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/Forge.app
xcrun simctl launch booted $(defaults read "$(pwd)/build/Build/Products/Debug-iphonesimulator/Forge.app/Info" CFBundleIdentifier)
```

(Substitute any installed simulator name. If voice input will be used in the simulator:
`xcrun simctl privacy booted grant microphone <bundle-id>`.)

## Step 4 — verify end-to-end

Backend smoke test (web build, ~2 min):

```bash
cd backend
ID=$(npx convex run projects:create '{"prompt":"a hello world page with one big button"}' | tr -d '"')
# poll until "live", then curl the previewUrl it returns:
npx convex run projects:get "{\"id\":\"$ID\"}"
```

Then in the app: tap **Enter App**, type a prompt, watch it build, tap the build card's
**Preview**. For mobile builds flip the **Web | Mobile** toggle (needs the Chorus key; first
device install will walk the user through Apple sign-in via a login link in the chat).

## Things agents commonly get wrong here

- After adding ANY new Swift file you must re-run `xcodegen generate` — the project uses
  explicit file references. Symptom: `xcodebuild -only-testing` runs 0 tests, or new types
  "don't exist".
- Prefer `-skip-testing:` over `-only-testing:` — a mistyped `-only-testing` filter silently
  runs zero tests and reports TEST SUCCEEDED.
- Daytona `POST /sandbox` can 403 with "Region ... is not available" under load — it's
  transient; the backend already retries 3×.
- Mobile builds take 2–5 min in Chorus's cloud; compile errors are auto-repaired (Claude gets
  the errors and rebuilds, up to 2 rounds) before a failure is shown.
- Device installs: if signing fails, the agent in the app posts an Apple login link or a
  device-registration link in the chat — that's the designed flow, not a bug.
- The AI proxy (`/ai/*` on your `.convex.site` domain) is disabled by default. Do not set
  `RILABLE_ALLOW_PUBLIC_AI_PROXY=true` unless the user explicitly accepts the spend risk for a
  disposable demo; otherwise use `RILABLE_ACCESS_TOKEN` and server-side calls only.

## Repo map

- `backend/convex/schema.ts` — projects / messages / files tables
- `backend/convex/builder.ts` — the whole build pipeline (web + mobile + self-repair + signing)
- `backend/convex/iosTemplate.ts` — embedded Xcode project template for generated iOS apps
- `backend/convex/http.ts` — Vercel AI Gateway proxy for generated apps
- `backend/convex/voice.ts` — Whisper transcription action
- `ios/Sources/` — the SwiftUI app (HomeView, ChatView, PreviewScreen, drawer, voice, models)
- `ios/UITests/` — UI tours used during development (expect projects from the dev DB; optional)
