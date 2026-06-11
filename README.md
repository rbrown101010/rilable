# Forge

**An open-source iPhone app that builds apps.** Type a prompt → an AI agent writes the code →
it goes live in the cloud → you preview it right inside the app. Web apps run in
[Daytona](https://daytona.io) sandboxes; native iOS apps are compiled by
[Chorus](https://ios.chorus.com) cloud Xcode and previewed in a browser iPhone simulator — or
installed on your real phone via an OTA link the agent drops in chat.

Built with SwiftUI + [Convex](https://convex.dev) + Claude. No auth, no waitlist — it's your
own stack, your own keys.

| | | |
|---|---|---|
| ![Home](docs/home.png) | ![Drawer](docs/drawer.png) | ![Chat](docs/chat.png) |

## The fastest way to set it up

Give this repo to [Claude Code](https://claude.com/claude-code) (or any capable coding agent)
and say:

> Clone https://github.com/rbrown101010/rilable and set it up for me.

[`CLAUDE.md`](CLAUDE.md) is written for the agent: it walks through creating the free Convex
backend, collecting each API key (with exact URLs), configuring the iOS app, building it, and
verifying an end-to-end build — asking you only for the keys.

Prefer to do it by hand? `CLAUDE.md` reads just as well for humans.

## What it does

- **Web | Mobile toggle** — web prompts become polished static web apps served from a public
  Daytona sandbox; mobile prompts become real SwiftUI apps compiled in the cloud
- **Live agent chat** — build status streams in real time (Convex subscriptions); follow-up
  messages edit the app; compile errors on mobile builds are auto-repaired by the agent
- **In-app preview** — web apps render in a WKWebView; iOS apps stream from a cloud iPhone
  simulator, with reload / open-in-Safari / share
- **Install on your iPhone** — ask the chat for "the download link" and the agent signs the
  build (ad-hoc, via your Apple account connected to Chorus) and posts an OTA install link
- **Model picker** — per-project Claude model (plus a "Fable 5" easter egg that's secretly
  Opus 4.8)
- **Voice input** — mic in every composer, transcribed by Whisper (key stays server-side)
- **AI skill for generated apps** — a keyless proxy to the Vercel AI Gateway means every app
  the agent builds can have AI features without leaking your key into client code

## Keys you'll need

Anthropic (required) · Daytona (web builds) · Forge access token (recommended before adding real keys) · Chorus (mobile builds) · OpenAI (voice,
optional) · Vercel AI Gateway (AI-powered generated apps, optional and disabled by default). All keys live as Convex
env vars on **your** deployment — none are committed, and generated apps never contain them.

## Honest caveats

- The Convex functions are single-user by design. Set `RILABLE_ACCESS_TOKEN` on your Convex
  deployment and the matching `AppConfig.accessToken` in the iOS app before attaching real API
  keys. Leaving it empty is only reasonable for local/no-key experiments.
- The `/ai/*` gateway proxy is disabled by default unless you set
  `RILABLE_ALLOW_PUBLIC_AI_PROXY=true`, or call it with `x-rilable-access-token` after
  configuring `RILABLE_ACCESS_TOKEN`. Treat public mode as a disposable demo switch.
- Android APK export needs a reachable builder service. Run `npm run android:builder` somewhere with the Android toolchain and set `FORGE_ANDROID_APK_BUILDER_URL` on Convex to its `/build` endpoint; use `FORGE_ANDROID_APK_BUILDER_TOKEN` on both sides if exposed beyond a trusted network.
- Web preview URLs are public links (that's what makes sharing work).
- The UI is an intentionally familiar mobile app-builder shell; if you ship this
  somewhere serious, re-skin it.

## License

MIT — see [LICENSE](LICENSE).
