import { v } from "convex/values";
import { query, internalMutation, internalQuery } from "./_generated/server";
import { requireAccessToken } from "./auth";

const fileShape = v.object({
  _id: v.id("files"),
  _creationTime: v.number(),
  projectId: v.id("projects"),
  path: v.string(),
  content: v.string(),
});

export const list = query({
  args: { projectId: v.id("projects"), accessToken: v.optional(v.string()) },
  returns: v.array(fileShape),
  handler: async (ctx, { projectId, accessToken }) => {
    requireAccessToken(accessToken);
    const files = await ctx.db
      .query("files")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    return files.sort((a, b) => a.path.localeCompare(b.path));
  },
});

export const getAll = internalQuery({
  args: { projectId: v.id("projects") },
  returns: v.array(fileShape),
  handler: async (ctx, { projectId }) => {
    return await ctx.db
      .query("files")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
  },
});

export const saveAll = internalMutation({
  args: {
    projectId: v.id("projects"),
    files: v.array(v.object({ path: v.string(), content: v.string() })),
  },
  returns: v.null(),
  handler: async (ctx, { projectId, files }) => {
    const existing = await ctx.db
      .query("files")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    for (const f of existing) await ctx.db.delete(f._id);
    for (const f of files) {
      await ctx.db.insert("files", { projectId, path: f.path, content: f.content });
    }
    return null;
  },
});
