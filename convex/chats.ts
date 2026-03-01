import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const DEFAULT_CHAT_TITLE = "New chat";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const chats = await ctx.db.query("chats").withIndex("by_updatedAt").collect();
    return chats.sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

export const create = mutation({
  args: {
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const title = args.title?.trim() || DEFAULT_CHAT_TITLE;
    return await ctx.db.insert("chats", {
      title,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const rename = mutation({
  args: {
    chatId: v.id("chats"),
    title: v.string(),
  },
  handler: async (ctx, args) => {
    const title = args.title.trim() || DEFAULT_CHAT_TITLE;
    await ctx.db.patch(args.chatId, {
      title,
      updatedAt: Date.now(),
    });
  },
});

export const get = query({
  args: {
    chatId: v.id("chats"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.chatId);
  },
});

export const setSandboxId = mutation({
  args: {
    chatId: v.id("chats"),
    sandboxId: v.string(),
  },
  handler: async (ctx, args) => {
    const chat = await ctx.db.get(args.chatId);
    if (!chat) return;
    await ctx.db.patch(args.chatId, {
      sandboxId: args.sandboxId,
      updatedAt: Date.now(),
    });
  },
});

export const remove = mutation({
  args: {
    chatId: v.id("chats"),
  },
  handler: async (ctx, args) => {
    const messages = await ctx.db
      .query("chatMessages")
      .withIndex("by_chatId_createdAt", (q) => q.eq("chatId", args.chatId))
      .collect();

    await Promise.all(messages.map((message) => ctx.db.delete(message._id)));
    await ctx.db.delete(args.chatId);
  },
});
