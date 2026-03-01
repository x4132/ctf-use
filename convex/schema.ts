import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const investigationStatus = v.union(
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("stopped"),
);

export default defineSchema({
  chats: defineTable({
    title: v.string(),
    targetUrl: v.optional(v.string()),
    investigations: v.array(
      v.object({
        agentId: v.string(),
        status: investigationStatus,
        lastActivityLine: v.optional(v.string()),
        updatedAt: v.number(),
      }),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_updatedAt", ["updatedAt"]),
  chatMessages: defineTable({
    chatId: v.id("chats"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    kind: v.union(v.literal("message"), v.literal("status")),
    createdAt: v.number(),
  }).index("by_chatId_createdAt", ["chatId", "createdAt"]),
  messages: defineTable({
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    createdAt: v.number(),
  }).index("by_createdAt", ["createdAt"]),
});
