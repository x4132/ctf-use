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
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_updatedAt", ["updatedAt"]),

  investigations: defineTable({
    chatId: v.id("chats"),
    agentId: v.string(),
    status: investigationStatus,
    liveBrowserUrl: v.optional(v.string()),
    output: v.optional(v.string()),
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
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_agentId", ["agentId"])
    .index("by_chatId", ["chatId"])
    .index("by_status", ["status"]),

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
