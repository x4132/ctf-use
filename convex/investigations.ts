import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const investigationStatus = v.union(
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("stopped"),
);
const messageKind = v.union(v.literal("message"), v.literal("status"));

export const listRunning = query({
  args: {},
  handler: async (ctx) => {
    const chats = await ctx.db.query("chats").collect();
    const running = chats.flatMap((chat) =>
      (chat.investigations ?? [])
        .filter((investigation) => investigation.status === "running")
        .map((investigation) => ({
          chatId: chat._id,
          agentId: investigation.agentId,
          status: investigation.status,
          lastActivityLine: investigation.lastActivityLine,
          updatedAt: investigation.updatedAt,
        })),
    );

    return running.sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

export const upsert = mutation({
  args: {
    chatId: v.id("chats"),
    agentId: v.string(),
    status: investigationStatus,
    activity: v.array(v.string()),
    output: v.optional(v.string()),
    error: v.optional(v.string()),
    finalMessage: v.optional(v.string()),
    finalMessageKind: v.optional(messageKind),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const chat = await ctx.db.get(args.chatId);
    if (!chat) {
      throw new Error("Chat not found");
    }

    const investigations = [...(chat.investigations ?? [])];
    const existingIndex = investigations.findIndex(
      (investigation) => investigation.agentId === args.agentId,
    );
    const existing =
      existingIndex >= 0 ? investigations[existingIndex] : null;

    let newActivity: string[];
    if (!existing?.lastActivityLine) {
      newActivity = args.activity;
    } else {
      const lastSeenIndex = args.activity.lastIndexOf(existing.lastActivityLine);
      newActivity = lastSeenIndex >= 0 ? args.activity.slice(lastSeenIndex + 1) : args.activity;
    }

    await Promise.all(
      newActivity.map((line, index) =>
        ctx.db.insert("chatMessages", {
          chatId: args.chatId,
          role: "assistant",
          content: line,
          kind: "status",
          createdAt: now + index,
        }),
      ),
    );

    const nextState = {
      agentId: args.agentId,
      status: args.status,
      lastActivityLine:
        args.activity.length > 0
          ? args.activity[args.activity.length - 1]
          : existing?.lastActivityLine,
      updatedAt: now,
    };

    if (existingIndex >= 0) {
      investigations[existingIndex] = nextState;
    } else {
      investigations.push(nextState);
    }

    const shouldInsertFinalMessage =
      args.status !== "running" &&
      Boolean(args.finalMessage?.trim()) &&
      (!existing || existing.status === "running");

    if (shouldInsertFinalMessage) {
      await ctx.db.insert("chatMessages", {
        chatId: args.chatId,
        role: "assistant",
        content: args.finalMessage!.trim(),
        kind: args.finalMessageKind ?? "status",
        createdAt: now + newActivity.length,
      });
    }

    await ctx.db.patch(args.chatId, {
      investigations,
      updatedAt: now,
    });

    return args.agentId;
  },
});
