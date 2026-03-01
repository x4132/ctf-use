import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const DEFAULT_CHAT_TITLE = "New chat";

export const listByChat = query({
  args: {
    chatId: v.id("chats"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("chatMessages")
      .withIndex("by_chatId_createdAt", (q) => q.eq("chatId", args.chatId))
      .collect();
  },
});

export const create = mutation({
  args: {
    chatId: v.id("chats"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    kind: v.optional(v.union(v.literal("message"), v.literal("status"))),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const insertedId = await ctx.db.insert("chatMessages", {
      chatId: args.chatId,
      role: args.role,
      content: args.content,
      kind: args.kind ?? "message",
      createdAt: now,
    });

    const chat = await ctx.db.get(args.chatId);
    if (chat) {
      const patch: { updatedAt: number; title?: string } = { updatedAt: now };
      if (args.role === "user" && chat.title === DEFAULT_CHAT_TITLE) {
        const trimmed = args.content.trim();
        if (trimmed.length > 0) {
          patch.title = trimmed.slice(0, 60);
        }
      }
      await ctx.db.patch(args.chatId, patch);
    }

    return insertedId;
  },
});
