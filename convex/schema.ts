import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  chats: defineTable({
    title: v.string(),
    sandboxId: v.optional(v.string()),
    status: v.optional(v.string()),
    isRunning: v.optional(v.boolean()),
    sandboxStopped: v.optional(v.boolean()),
    liveUrl: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_updatedAt", ["updatedAt"]),

  chatMessages: defineTable({
    chatId: v.id("chats"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    kind: v.union(v.literal("message"), v.literal("status"), v.literal("tool"), v.literal("reasoning")),
    createdAt: v.number(),
  }).index("by_chatId_createdAt", ["chatId", "createdAt"]),
});
