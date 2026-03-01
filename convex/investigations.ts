import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const investigationStatus = v.union(
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("stopped"),
);

export const listRunning = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("investigations")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .collect();
  },
});

export const listByChatId = query({
  args: { chatId: v.id("chats") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("investigations")
      .withIndex("by_chatId", (q) => q.eq("chatId", args.chatId))
      .collect();
  },
});

export const getByAgentId = query({
  args: { agentId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("investigations")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
      .first();
  },
});

export const create = mutation({
  args: {
    chatId: v.id("chats"),
    agentId: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("investigations", {
      chatId: args.chatId,
      agentId: args.agentId,
      status: "running",
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateState = mutation({
  args: {
    agentId: v.string(),
    status: v.optional(investigationStatus),
    liveBrowserUrl: v.optional(v.string()),
    output: v.optional(v.string()),
    error: v.optional(v.string()),
    signals: v.optional(
      v.array(
        v.object({
          type: v.string(),
          confidence: v.string(),
          details: v.string(),
          evidence: v.string(),
          suggestedFollowUps: v.array(v.string()),
        }),
      ),
    ),
    toolsCalled: v.optional(v.array(v.string())),
    stepsUsed: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const investigation = await ctx.db
      .query("investigations")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
      .first();
    if (!investigation) {
      throw new Error(`Investigation not found for agentId: ${args.agentId}`);
    }

    const { agentId: _, ...updates } = args;
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        patch[key] = value;
      }
    }

    await ctx.db.patch(investigation._id, patch);
  },
});
