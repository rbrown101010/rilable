import { v } from "convex/values";
import {
  query,
  mutation,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { isAllowedModel, DEFAULT_MODEL_KEY } from "./models";
import { requireAccessToken } from "./auth";

const projectShape = v.object({
  _id: v.id("projects"),
  _creationTime: v.number(),
  name: v.string(),
  emoji: v.string(),
  prompt: v.string(),
  status: v.string(),
  statusDetail: v.optional(v.string()),
  platform: v.optional(v.string()),
  model: v.optional(v.string()),
  sandboxId: v.optional(v.string()),
  previewUrl: v.optional(v.string()),
  buildJobId: v.optional(v.string()),
  appUrl: v.optional(v.string()),
  simBuildId: v.optional(v.string()),
  signBuildId: v.optional(v.string()),
  installUrl: v.optional(v.string()),
  version: v.number(),
  error: v.optional(v.string()),
  updatedAt: v.number(),
});

export const list = query({
  args: { accessToken: v.optional(v.string()) },
  returns: v.array(projectShape),
  handler: async (ctx, { accessToken }) => {
    requireAccessToken(accessToken);
    return await ctx.db.query("projects").order("desc").take(100);
  },
});

export const get = query({
  args: { id: v.id("projects"), accessToken: v.optional(v.string()) },
  returns: v.union(projectShape, v.null()),
  handler: async (ctx, { id, accessToken }) => {
    requireAccessToken(accessToken);
    return await ctx.db.get(id);
  },
});

export const create = mutation({
  args: {
    prompt: v.string(),
    platform: v.optional(v.string()),
    model: v.optional(v.string()),
    accessToken: v.optional(v.string()),
  },
  returns: v.id("projects"),
  handler: async (ctx, { prompt, platform, model, accessToken }) => {
    requireAccessToken(accessToken);
    const target = platform === "mobile" ? "mobile" : "web";
    const id = await ctx.db.insert("projects", {
      name: "New App",
      emoji: "✨",
      prompt,
      status: "queued",
      statusDetail: "Queued for build",
      platform: target,
      model: model && isAllowedModel(model) ? model : DEFAULT_MODEL_KEY,
      version: 0,
      updatedAt: Date.now(),
    });
    await ctx.db.insert("messages", { projectId: id, role: "user", content: prompt });
    if (target === "mobile") {
      await ctx.scheduler.runAfter(0, internal.builder.buildMobile, { projectId: id });
    } else {
      await ctx.scheduler.runAfter(0, internal.builder.build, { projectId: id });
    }
    return id;
  },
});

export const retry = mutation({
  args: { id: v.id("projects"), accessToken: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { id, accessToken }) => {
    requireAccessToken(accessToken);
    const project = await ctx.db.get(id);
    if (!project) return null;
    await ctx.db.patch(id, {
      status: "queued",
      statusDetail: "Rebuilding",
      error: undefined,
      updatedAt: Date.now(),
    });
    if (project.platform === "mobile") {
      await ctx.scheduler.runAfter(0, internal.builder.buildMobile, { projectId: id });
    } else {
      await ctx.scheduler.runAfter(0, internal.builder.build, { projectId: id });
    }
    return null;
  },
});

// Fired when a project is opened on the phone. Web: wake an auto-stopped
// sandbox. Mobile: refresh the tokenized simulator preview if needed.
export const wake = mutation({
  args: { id: v.id("projects"), accessToken: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { id, accessToken }) => {
    requireAccessToken(accessToken);
    const project = await ctx.db.get(id);
    if (!project || project.status !== "live") return null;
    if (!project.sandboxId && project.platform !== "mobile") return null;
    await ctx.scheduler.runAfter(0, internal.builder.ensureRunning, { projectId: id });
    return null;
  },
});

// Switch which Claude model the agent uses for this project's future builds.
export const setModel = mutation({
  args: { id: v.id("projects"), model: v.string(), accessToken: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { id, model, accessToken }) => {
    requireAccessToken(accessToken);
    if (!isAllowedModel(model)) throw new Error("Unknown model");
    const project = await ctx.db.get(id);
    if (!project) return null;
    await ctx.db.patch(id, { model, updatedAt: Date.now() });
    return null;
  },
});

export const remove = mutation({
  args: { id: v.id("projects"), accessToken: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { id, accessToken }) => {
    requireAccessToken(accessToken);
    const project = await ctx.db.get(id);
    if (!project) return null;
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_project", (q) => q.eq("projectId", id))
      .collect();
    for (const m of messages) await ctx.db.delete(m._id);
    const files = await ctx.db
      .query("files")
      .withIndex("by_project", (q) => q.eq("projectId", id))
      .collect();
    for (const f of files) await ctx.db.delete(f._id);
    await ctx.db.delete(id);
    if (project.sandboxId) {
      await ctx.scheduler.runAfter(0, internal.builder.destroySandbox, {
        sandboxId: project.sandboxId,
      });
    }
    return null;
  },
});

export const getInternal = internalQuery({
  args: { id: v.id("projects") },
  returns: v.union(projectShape, v.null()),
  handler: async (ctx, { id }) => {
    return await ctx.db.get(id);
  },
});

export const update = internalMutation({
  args: {
    id: v.id("projects"),
    name: v.optional(v.string()),
    emoji: v.optional(v.string()),
    status: v.optional(v.string()),
    statusDetail: v.optional(v.string()),
    sandboxId: v.optional(v.string()),
    previewUrl: v.optional(v.string()),
    buildJobId: v.optional(v.string()),
    appUrl: v.optional(v.string()),
    simBuildId: v.optional(v.string()),
    signBuildId: v.optional(v.string()),
    installUrl: v.optional(v.string()),
    version: v.optional(v.number()),
    error: v.optional(v.string()),
    clearError: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, { id, clearError, ...patch }) => {
    const project = await ctx.db.get(id);
    if (!project) return null;
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) clean[key] = value;
    }
    if (clearError) clean.error = undefined;
    await ctx.db.patch(id, { ...clean, updatedAt: Date.now() });
    return null;
  },
});
