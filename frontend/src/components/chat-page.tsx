import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  getStatusBadge,
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  usePromptInputController,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { api } from "../../../convex/_generated/api";
import type { ToolPart } from "@/components/ai-elements/tool";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import { Globe, Maximize2, Minimize2, Square, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

const DEFAULT_CHAT_TITLE = "New chat";

type ChatId = Id<"chats">;
type ChatDoc = Doc<"chats">;

function PromptControllerBridge({
  controllerRef,
}: {
  controllerRef: React.RefObject<{ setInput: (v: string) => void } | null>;
}) {
  const controller = usePromptInputController();
  useEffect(() => {
    controllerRef.current = { setInput: controller.textInput.setInput };
  }, [controller, controllerRef]);
  return null;
}

function BrowserPanel({
  liveUrl,
  isFullscreen,
  onClose,
  onToggleFullscreen,
}: {
  liveUrl: string;
  isFullscreen: boolean;
  onClose: () => void;
  onToggleFullscreen: () => void;
}) {
  return (
    <div
      className={
        isFullscreen
          ? "fixed inset-4 z-50 flex flex-col overflow-hidden rounded-lg border border-border bg-background shadow-lg"
          : "flex w-150 shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-background"
      }
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <p className="truncate text-sm font-medium">Browser View</p>
        <div className="flex gap-1">
          <Button
            className="h-7 w-7 p-0"
            onClick={onToggleFullscreen}
            type="button"
            variant="ghost"
          >
            {isFullscreen ? (
              <Minimize2 className="size-4" />
            ) : (
              <Maximize2 className="size-4" />
            )}
          </Button>
          <Button
            className="h-7 w-7 p-0"
            onClick={onClose}
            type="button"
            variant="ghost"
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>
      <iframe
        src={liveUrl}
        className="w-full flex-1"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups aspect-video"
        title="Live browser session"
      />
    </div>
  );
}

export function ChatPage() {
  const chats = useQuery(api.chats.list);
  const chatList = chats ?? [];

  const createChat = useMutation(api.chats.create);
  const renameChat = useMutation(api.chats.rename);
  const removeChat = useMutation(api.chats.remove);
  const sendMessage = trpc.chat.send.useMutation();
  const stopAgent = trpc.chat.stop.useMutation();
  const destroySandbox = trpc.chat.destroy.useMutation();
  const setLiveUrl = useMutation(api.chats.setLiveUrl);
  const [selectedChatId, setSelectedChatId] = useState<ChatId | null>(null);
  const [renamingChatId, setRenamingChatId] = useState<ChatId | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [browserFullscreen, setBrowserFullscreen] = useState(false);
  const [browserHidden, setBrowserHidden] = useState(false);
  const isCreatingInitialChatRef = useRef(false);
  const promptControllerRef = useRef<{ setInput: (v: string) => void } | null>(
    null,
  );

  const activeChatId =
    selectedChatId && chatList.some((chat) => chat._id === selectedChatId)
      ? selectedChatId
      : (chatList[0]?._id ?? null);
  const selectedChat =
    chatList.find((chat) => chat._id === activeChatId) ?? null;
  const rawLiveUrl = selectedChat?.liveUrl ?? null;
  const liveUrl = browserHidden ? null : rawLiveUrl;

  // Reset local overrides when the underlying URL changes
  if (!rawLiveUrl && browserHidden) {
    setBrowserHidden(false);
  }
  if (!rawLiveUrl && browserFullscreen) {
    setBrowserFullscreen(false);
  }

  const handleCloseBrowser = () => {
    if (activeChatId) {
      setBrowserHidden(true);
      setBrowserFullscreen(false);
      setLiveUrl({ chatId: activeChatId }).catch(console.error);
    }
  };

  const messages =
    useQuery(
      api.messages.listByChat,
      activeChatId ? { chatId: activeChatId } : "skip",
    ) ?? [];

  useEffect(() => {
    if (
      chats === undefined ||
      chatList.length > 0 ||
      isCreatingInitialChatRef.current
    ) {
      return;
    }

    isCreatingInitialChatRef.current = true;
    createChat({})
      .then((chatId) => {
        setSelectedChatId(chatId);
      })
      .catch((error) => {
        console.error("Failed to create initial chat session", error);
      })
      .finally(() => {
        isCreatingInitialChatRef.current = false;
      });
  }, [chatList.length, chats, createChat]);

  const handleCreateChat = () => {
    createChat({})
      .then((chatId) => {
        setSelectedChatId(chatId);
      })
      .catch((error) => {
        console.error("Failed to create chat", error);
      });
  };

  const handleStartRename = (chat: ChatDoc) => {
    setRenamingChatId(chat._id);
    setRenameValue(chat.title);
  };

  const handleSaveRename = () => {
    if (!renamingChatId) {
      return;
    }

    renameChat({ chatId: renamingChatId, title: renameValue })
      .then(() => {
        setRenamingChatId(null);
        setRenameValue("");
      })
      .catch((error) => {
        console.error("Failed to rename chat session", error);
      });
  };

  const handleDeleteChat = async (chatId: ChatId) => {
    try {
      // Stop the agent first so the SSE stream exits before messages are deleted
      await stopAgent.mutateAsync({ chatId });
    } catch {
      // best-effort — agent may not be running
    }

    try {
      // Destroy sandbox if one exists for this chat
      await destroySandbox.mutateAsync({ chatId });
    } catch {
      // best-effort — sandbox may not exist
    }

    try {
      await removeChat({ chatId });
      if (selectedChatId === chatId) {
        setSelectedChatId(null);
      }
      if (renamingChatId === chatId) {
        setRenamingChatId(null);
        setRenameValue("");
      }
    } catch (error) {
      console.error("Failed to delete chat session", error);
    }
  };

  const handleSubmit = async (message: PromptInputMessage) => {
    const text = message.text.trim();
    if (!text) return;

    let chatId = activeChatId;
    if (!chatId) {
      try {
        chatId = await createChat({});
        setSelectedChatId(chatId);
      } catch (error) {
        console.error("Failed to create chat for message", error);
        return;
      }
    }

    // Fire agent in background — backend streams all messages (user + assistant) to Convex via OpenCode events
    sendMessage.mutateAsync({ chatId, message: text }).catch(console.error);
  };

  // Group consecutive tool messages with the same toolName
  type ToolData = {
    toolName: string;
    state: ToolPart["state"];
    input: ToolPart["input"];
    output: ToolPart["output"];
    errorText: ToolPart["errorText"];
  };
  type MessageItem = { type: "message"; msg: (typeof messages)[number] };
  type ToolGroup = {
    type: "toolGroup";
    key: string;
    toolName: string;
    items: { msg: (typeof messages)[number]; data: ToolData }[];
  };
  type RenderItem = MessageItem | ToolGroup;

  const renderItems = useMemo<RenderItem[]>(() => {
    const items: RenderItem[] = [];
    for (const msg of messages) {
      if (msg.kind === "tool") {
        try {
          const data = JSON.parse(msg.content) as ToolData;
          const lastItem = items[items.length - 1];
          if (
            lastItem?.type === "toolGroup" &&
            lastItem.toolName === data.toolName
          ) {
            lastItem.items.push({ msg, data });
            lastItem.key += `,${msg._id}`;
          } else {
            items.push({
              type: "toolGroup",
              key: msg._id,
              toolName: data.toolName,
              items: [{ msg, data }],
            });
          }
        } catch {
          items.push({ type: "message", msg });
        }
      } else {
        items.push({ type: "message", msg });
      }
    }
    return items;
  }, [messages]);

  return (
    <div className="mx-auto flex h-screen w-full gap-4 p-4">
      <aside className="flex w-72 shrink-0 flex-col rounded-lg border border-border bg-muted/20 p-3">
        <Button onClick={handleCreateChat} type="button" variant="outline">
          New chat
        </Button>
        <div className="mt-3 flex-1 space-y-2 overflow-y-auto">
          {chatList.map((chat) => {
            const active = activeChatId === chat._id;
            const isRenaming = renamingChatId === chat._id;

            return (
              <Button
                className={`h-auto w-full justify-start px-3 py-2 text-left ${
                  active
                    ? "border-primary bg-primary/10 hover:bg-primary/10"
                    : ""
                }`}
                key={chat._id}
                onClick={() => {
                  setSelectedChatId(chat._id);
                }}
                type="button"
                variant="outline"
              >
                {isRenaming ? (
                  <div className="w-full space-y-2">
                    <input
                      className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
                      onChange={(event) => {
                        setRenameValue(event.currentTarget.value);
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          event.stopPropagation();
                          handleSaveRename();
                        }
                        if (event.key === "Escape") {
                          event.preventDefault();
                          event.stopPropagation();
                          setRenamingChatId(null);
                          setRenameValue("");
                        }
                      }}
                      value={renameValue}
                    />
                    <div className="flex gap-2">
                      <Button
                        className="h-auto px-2 py-1 text-xs"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleSaveRename();
                        }}
                        type="button"
                        variant="outline"
                      >
                        Save
                      </Button>
                      <Button
                        className="h-auto px-2 py-1 text-xs"
                        onClick={(event) => {
                          event.stopPropagation();
                          setRenamingChatId(null);
                          setRenameValue("");
                        }}
                        type="button"
                        variant="outline"
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="w-full">
                    <div className="flex items-start justify-between gap-2">
                      <p className="truncate text-sm font-medium">
                        {chat.title || DEFAULT_CHAT_TITLE}
                      </p>
                      <div className="flex gap-1">
                        <Button
                          className="h-auto px-1.5 py-0.5 text-[10px]"
                          onClick={(event) => {
                            event.stopPropagation();
                            handleStartRename(chat);
                          }}
                          type="button"
                          variant="outline"
                        >
                          Rename
                        </Button>
                        <Button
                          className="h-auto px-1.5 py-0.5 text-[10px]"
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleDeleteChat(chat._id);
                          }}
                          type="button"
                          variant="outline"
                        >
                          Delete
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </Button>
            );
          })}
        </div>
      </aside>

      {liveUrl && (
        <BrowserPanel
          liveUrl={liveUrl}
          isFullscreen={browserFullscreen}
          onClose={handleCloseBrowser}
          onToggleFullscreen={() => setBrowserFullscreen((prev) => !prev)}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col rounded-lg border border-border bg-background">
        <div className="border-b border-border px-4 py-3">
          <p className="truncate text-sm font-medium">
            {selectedChat?.title ?? DEFAULT_CHAT_TITLE}
          </p>
        </div>

        <Conversation className="flex-1">
          <ConversationContent>
            {messages.length === 0 ? (
              <ConversationEmptyState
                icon={<Globe className="size-10" />}
                title="hacker-use"
                description="Describe your CTF challenge to start investigating"
              />
            ) : (
              renderItems.map((item) => {
                if (item.type === "toolGroup") {
                  const { items, toolName } = item;
                  // Aggregate state: worst state wins (error > running > completed)
                  const hasError = items.some(
                    (i) => i.data.state === "output-error",
                  );
                  const hasRunning = items.some(
                    (i) => i.data.state === "input-available",
                  );
                  const groupState: ToolPart["state"] = hasError
                    ? "output-error"
                    : hasRunning
                      ? "input-available"
                      : "output-available";
                  const title =
                    items.length > 1
                      ? `${toolName} (${items.length})`
                      : toolName;

                  return (
                    <Tool key={item.key}>
                      <ToolHeader
                        type="dynamic-tool"
                        state={groupState}
                        toolName={toolName}
                        title={title}
                      />
                      <ToolContent>
                        {items.map(({ msg, data }) => (
                          <div key={msg._id} className="space-y-2">
                            {items.length > 1 && (
                              <div className="flex items-center gap-2 border-b pb-2">
                                {getStatusBadge(data.state)}
                              </div>
                            )}
                            {data.input ? (
                              <ToolInput input={data.input} />
                            ) : null}
                            {data.output || data.errorText ? (
                              <ToolOutput
                                output={data.output}
                                errorText={data.errorText}
                              />
                            ) : null}
                          </div>
                        ))}
                      </ToolContent>
                    </Tool>
                  );
                }

                return (
                  <Message from={item.msg.role} key={item.msg._id}>
                    <MessageContent>
                      <MessageResponse>{item.msg.content}</MessageResponse>
                    </MessageContent>
                  </Message>
                );
              })
            )}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        {selectedChat?.status && (
          <div className="border-t border-border px-4 py-2">
            <p className="text-xs text-muted-foreground">
              {selectedChat.status}
            </p>
          </div>
        )}

        <div className="p-4">
          <PromptInputProvider>
            <PromptControllerBridge controllerRef={promptControllerRef} />
            <PromptInput onSubmit={handleSubmit}>
              <PromptInputBody>
                <PromptInputTextarea
                  disabled={sendMessage.isPending}
                  placeholder="Describe your CTF challenge..."
                />
              </PromptInputBody>
              <PromptInputFooter>
                <div />
                <div className="flex items-center gap-1">
                  {selectedChat?.isRunning && (
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="size-8"
                      onClick={() => {
                        if (activeChatId) {
                          stopAgent
                            .mutateAsync({ chatId: activeChatId })
                            .catch(console.error);
                        }
                      }}
                      aria-label="Stop"
                    >
                      <Square className="size-3.5 fill-current" />
                    </Button>
                  )}
                  <PromptInputSubmit
                    disabled={sendMessage.isPending}
                    status={sendMessage.isPending ? "submitted" : "ready"}
                  />
                </div>
              </PromptInputFooter>
            </PromptInput>
          </PromptInputProvider>
        </div>
      </div>
    </div>
  );
}
