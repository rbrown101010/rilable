"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { requireAccessToken } from "./auth";

/// Transcribe a short voice recording (base64 m4a/AAC) with OpenAI Whisper.
/// The OpenAI key lives only on the deployment — never in the iOS app.
export const transcribe = action({
  args: { audioBase64: v.string(), accessToken: v.optional(v.string()) },
  returns: v.object({ text: v.string() }),
  handler: async (_ctx, { audioBase64, accessToken }) => {
    requireAccessToken(accessToken);
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY is not set on the Convex deployment");
    const bytes = Buffer.from(audioBase64, "base64");
    if (bytes.length < 1_000) return { text: "" };
    if (bytes.length > 10_000_000) throw new Error("Recording too large");
    const audio = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

    const form = new FormData();
    form.append("file", new Blob([audio], { type: "audio/m4a" }), "audio.m4a");
    form.append("model", "whisper-1");
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Transcription failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as { text?: string };
    return { text: (data.text ?? "").trim() };
  },
});
