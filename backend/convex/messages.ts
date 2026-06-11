import { v } from "convex/values";
import {
  query,
  mutation,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { isAllowedModel } from "./models";
import { requireAccessToken } from "./auth";
import { wantsAndroidApk } from "./android";

const messageShape = v.object({
  _id: v.id("messages"),
  _creationTime: v.number(),
  projectId: v.id("projects"),
  role: v.string(),
  content: v.string(),
});

const BUSY_STATUSES = [
  "queued",
  "generating",
  "sandbox",
  "uploading",
  "starting",
  "waking",
  "updating",
  "building",
  "signing",
];

/// Mobile-only: is this message asking for the device install / download link
/// rather than requesting a code change?
function wantsInstallLink(text: string): boolean {
  const t = text.toLowerCase();
  if (/\b(download|install)\b[\s\S]{0,40}\b(link|url|ipa|iphone|phone|device)\b/.test(t)) return true;
  if (/\b(link|url)\b[\s\S]{0,40}\b(download|install)\b/.test(t)) return true;
  if (/\bon my (i?phone|device)\b/.test(t) && /\b(get|put|install|download|run|try)\b/.test(t)) return true;
  return false;
}

export const list = query({
  args: { projectId: v.id("projects"), accessToken: v.optional(v.string()) },
  returns: v.array(messageShape),
  handler: async (ctx, { projectId, accessToken }) => {
    requireAccessToken(accessToken);
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .order("desc")
      .take(200);
    return recent.reverse();
  },
});

export const send = mutation({
  args: {
    projectId: v.id("projects"),
    content: v.string(),
    model: v.optional(v.string()),
    accessToken: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { projectId, content, model, accessToken }) => {
    requireAccessToken(accessToken);
    const project = await ctx.db.get(projectId);
    if (!project) throw new Error("Project not found");
    if (BUSY_STATUSES.includes(project.status)) {
      throw new Error("The agent is still working — wait for it to finish");
    }
    if (model && isAllowedModel(model) && model !== project.model) {
      await ctx.db.patch(projectId, { model });
    }
    await ctx.db.insert("messages", { projectId, role: "user", content });
    if (project.platform !== "mobile" && wantsAndroidApk(content)) {
      await ctx.db.patch(projectId, {
        status: "building",
        statusDetail: "Building Android APK",
        updatedAt: Date.now(),
      });
      await ctx.scheduler.runAfter(0, internal.builder.buildAndroidApk, { projectId });
    } else if (project.platform === "mobile" && wantsInstallLink(content)) {
      await ctx.db.patch(projectId, {
        status: "signing",
        statusDetail: "Preparing your install link",
        updatedAt: Date.now(),
      });
      await ctx.scheduler.runAfter(0, internal.builder.provideInstallLink, { projectId });
    } else if (project.platform === "mobile") {
      await ctx.db.patch(projectId, {
        status: "updating",
        statusDetail: "Applying your changes",
        updatedAt: Date.now(),
      });
      await ctx.scheduler.runAfter(0, internal.builder.editMobile, { projectId });
    } else {
      await ctx.db.patch(projectId, {
        status: "updating",
        statusDetail: "Applying your changes",
        updatedAt: Date.now(),
      });
      await ctx.scheduler.runAfter(0, internal.builder.edit, { projectId });
    }
    return null;
  },
});

export const log = internalMutation({
  args: { projectId: v.id("projects"), role: v.string(), content: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("messages", args);
    return null;
  },
});

export const recent = internalQuery({
  args: { projectId: v.id("projects"), limit: v.number() },
  returns: v.array(messageShape),
  handler: async (ctx, { projectId, limit }) => {
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .order("desc")
      .take(limit);
    return recent.reverse();
  },
});
