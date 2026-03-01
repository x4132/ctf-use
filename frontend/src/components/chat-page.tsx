import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation"
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message"
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { trpc } from "@/lib/trpc"
import { api } from "../../../convex/_generated/api"
import type { Doc, Id } from "../../../convex/_generated/dataModel"
import { useMutation, useQuery } from "convex/react"
import { Globe } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"

const DEFAULT_GOAL =
  "Find exploitable web vulnerabilities and retrieve the flag if possible."
const DEFAULT_CHAT_TITLE = "New chat"
const URL_REGEX = /https?:\/\/[^\s]+/i

type ChatId = Id<"chats">
type ChatDoc = Doc<"chats">

function cleanUrl(raw: string): string {
  return raw.replace(/[),.;!?]+$/, "")
}

function parseInvestigationInput(
  text: string,
  fallbackTargetUrl: string | null,
): { targetUrl: string; goal: string } | null {
  const urlMatch = text.match(URL_REGEX)

  if (urlMatch) {
    const targetUrl = cleanUrl(urlMatch[0])
    const goal = text.replace(urlMatch[0], "").trim() || DEFAULT_GOAL
    return { targetUrl, goal }
  }

  if (!fallbackTargetUrl) {
    return null
  }

  return {
    targetUrl: fallbackTargetUrl,
    goal: text.trim() || DEFAULT_GOAL,
  }
}

export function ChatPage() {
  const chats = useQuery(api.chats.list)
  const chatList = chats ?? []
  const runningInvestigations = useQuery(api.investigations.listRunning) ?? []

  const createChat = useMutation(api.chats.create)
  const renameChat = useMutation(api.chats.rename)
  const removeChat = useMutation(api.chats.remove)
  const updateTargetUrl = useMutation(api.chats.updateTargetUrl)
  const createMessage = useMutation(api.messages.create)

  const investigateMutation = trpc.agent.investigate.useMutation()
  const stopMutation = trpc.agent.stop.useMutation()
  const destroyMutation = trpc.agent.destroy.useMutation()

  const [selectedChatId, setSelectedChatId] = useState<ChatId | null>(null)
  const [renamingChatId, setRenamingChatId] = useState<ChatId | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const [stoppingAgentIds, setStoppingAgentIds] = useState<Record<string, boolean>>({})
  const isCreatingInitialChatRef = useRef(false)

  const activeChatId =
    selectedChatId && chatList.some((chat) => chat._id === selectedChatId)
      ? selectedChatId
      : (chatList[0]?._id ?? null)
  const selectedChat = chatList.find((chat) => chat._id === activeChatId) ?? null
  const targetUrl = selectedChat?.targetUrl ?? null
  const messages =
    useQuery(
      api.messages.listByChat,
      activeChatId ? { chatId: activeChatId } : "skip",
    ) ?? []

  // Get investigations for the active chat from Convex
  const chatInvestigations =
    useQuery(
      api.investigations.listByChatId,
      activeChatId ? { chatId: activeChatId } : "skip",
    ) ?? []
  const selectedChatRunning = chatInvestigations.filter(
    (inv) => inv.status === "running",
  )

  const runningCountByChat = runningInvestigations.reduce<Record<string, number>>(
    (acc, investigation) => {
      const key = investigation.chatId
      acc[key] = (acc[key] ?? 0) + 1
      return acc
    },
    {},
  )

  useEffect(() => {
    if (chats === undefined || chatList.length > 0 || isCreatingInitialChatRef.current) {
      return
    }

    isCreatingInitialChatRef.current = true
    createChat({})
      .then((chatId) => {
        setSelectedChatId(chatId)
      })
      .catch((error) => {
        console.error("Failed to create initial chat session", error)
      })
      .finally(() => {
        isCreatingInitialChatRef.current = false
      })
  }, [chatList.length, chats, createChat])

  const persistMessage = useCallback(
    (
      chatId: ChatId,
      role: "user" | "assistant",
      content: string,
      kind: "message" | "status" = "message",
    ) => {
      createMessage({ chatId, role, content, kind }).catch((error) => {
        console.error("Failed to persist chat message", error)
      })
    },
    [createMessage],
  )

  const handleCreateChat = () => {
    createChat({})
      .then((chatId) => {
        setSelectedChatId(chatId)
      })
      .catch((error) => {
        console.error("Failed to create chat", error)
      })
  }

  const handleStartRename = (chat: ChatDoc) => {
    setRenamingChatId(chat._id)
    setRenameValue(chat.title)
  }

  const handleSaveRename = () => {
    if (!renamingChatId) {
      return
    }

    renameChat({ chatId: renamingChatId, title: renameValue })
      .then(() => {
        setRenamingChatId(null)
        setRenameValue("")
      })
      .catch((error) => {
        console.error("Failed to rename chat session", error)
      })
  }

  const handleDeleteChat = async (chatId: ChatId) => {
    if (!window.confirm("Delete this chat session and all stored messages?")) {
      return
    }

    const runningForChat = runningInvestigations.filter(
      (investigation) => investigation.chatId === chatId,
    )

    await Promise.all(
      runningForChat.map(async (investigation) => {
        try {
          await stopMutation.mutateAsync({ agentId: investigation.agentId })
        } catch {
          // Best effort: investigation might already be completed or gone.
        }

        try {
          await destroyMutation.mutateAsync({ agentId: investigation.agentId })
        } catch {
          // Best effort cleanup.
        }
      }),
    )

    try {
      await removeChat({ chatId })
      if (selectedChatId === chatId) {
        setSelectedChatId(null)
      }
      if (renamingChatId === chatId) {
        setRenamingChatId(null)
        setRenameValue("")
      }
    } catch (error) {
      console.error("Failed to delete chat session", error)
    }
  }

  const handleStopInvestigation = async (investigation: Doc<"investigations">) => {
    if (stoppingAgentIds[investigation.agentId]) {
      return
    }

    setStoppingAgentIds((current) => ({
      ...current,
      [investigation.agentId]: true,
    }))

    try {
      await stopMutation.mutateAsync({
        agentId: investigation.agentId,
      })
    } catch (error) {
      console.error("Failed to stop investigation", error)
      persistMessage(
        investigation.chatId,
        "assistant",
        "Failed to stop investigation. Please try again.",
        "status",
      )
    } finally {
      setStoppingAgentIds((current) => {
        const next = { ...current }
        delete next[investigation.agentId]
        return next
      })
    }
  }

  const handleSubmit = async (message: PromptInputMessage) => {
    const text = message.text.trim()
    if (!text) return

    let chatId = activeChatId
    if (!chatId) {
      try {
        chatId = await createChat({})
        setSelectedChatId(chatId)
      } catch (error) {
        console.error("Failed to create chat for message", error)
        return
      }
    }

    persistMessage(chatId, "user", text)

    const parsed = parseInvestigationInput(text, targetUrl)
    if (!parsed) {
      persistMessage(
        chatId,
        "assistant",
        "Provide a target URL in your first message (e.g. https://target.example.com).",
        "status",
      )
      return
    }

    updateTargetUrl({ chatId, targetUrl: parsed.targetUrl }).catch((error) => {
      console.error("Failed to persist target URL", error)
    })

    const contextMessages =
      chatId === activeChatId
        ? messages.filter((item) => item.kind === "message")
        : []
    const context = [...contextMessages, { role: "user" as const, content: text }]
      .slice(-4)
      .map((item) => `${item.role}: ${item.content}`)
      .join("\n")

    try {
      await investigateMutation.mutateAsync({
        chatId,
        targetUrl: parsed.targetUrl,
        goal: parsed.goal,
        context,
      })
    } catch {
      persistMessage(
        chatId,
        "assistant",
        "Failed to start investigation. Please try again.",
        "status",
      )
    }
  }

  return (
    <div className="mx-auto flex h-screen w-full max-w-6xl gap-4 p-4">
      <aside className="flex w-72 shrink-0 flex-col rounded-lg border border-border bg-muted/20 p-3">
        <Button
          onClick={handleCreateChat}
          type="button"
          variant="outline"
        >
          New chat
        </Button>
        <div className="mt-3 flex-1 space-y-2 overflow-y-auto">
          {chatList.map((chat) => {
            const active = activeChatId === chat._id
            const runningCount = runningCountByChat[chat._id] ?? 0
            const isRenaming = renamingChatId === chat._id

            return (
              <Button
                className={`h-auto w-full justify-start px-3 py-2 text-left ${
                  active ? "border-primary bg-primary/10 hover:bg-primary/10" : ""
                }`}
                key={chat._id}
                onClick={() => {
                  setSelectedChatId(chat._id)
                }}
                type="button"
                variant="outline"
              >
                {isRenaming ? (
                  <div className="w-full space-y-2">
                    <input
                      className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
                      onChange={(event) => {
                        setRenameValue(event.currentTarget.value)
                      }}
                      onClick={(event) => {
                        event.stopPropagation()
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault()
                          event.stopPropagation()
                          handleSaveRename()
                        }
                        if (event.key === "Escape") {
                          event.preventDefault()
                          event.stopPropagation()
                          setRenamingChatId(null)
                          setRenameValue("")
                        }
                      }}
                      value={renameValue}
                    />
                    <div className="flex gap-2">
                      <Button
                        className="h-auto px-2 py-1 text-xs"
                        onClick={(event) => {
                          event.stopPropagation()
                          handleSaveRename()
                        }}
                        type="button"
                        variant="outline"
                      >
                        Save
                      </Button>
                      <Button
                        className="h-auto px-2 py-1 text-xs"
                        onClick={(event) => {
                          event.stopPropagation()
                          setRenamingChatId(null)
                          setRenameValue("")
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
                            event.stopPropagation()
                            handleStartRename(chat)
                          }}
                          type="button"
                          variant="outline"
                        >
                          Rename
                        </Button>
                        <Button
                          className="h-auto px-1.5 py-0.5 text-[10px]"
                          onClick={(event) => {
                            event.stopPropagation()
                            void handleDeleteChat(chat._id)
                          }}
                          type="button"
                          variant="outline"
                        >
                          Delete
                        </Button>
                      </div>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {runningCount > 0
                        ? `${runningCount} investigation${runningCount > 1 ? "s" : ""} running`
                        : chat.targetUrl ?? "No target URL yet"}
                    </p>
                  </div>
                )}
              </Button>
            )
          })}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col rounded-lg border border-border bg-background">
        <div className="border-b border-border px-4 py-3">
          <p className="truncate text-sm font-medium">
            {selectedChat?.title ?? DEFAULT_CHAT_TITLE}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {targetUrl ?? "No target URL set"}
          </p>
        </div>

        <Conversation className="flex-1">
          <ConversationContent>
            {messages.length === 0 && selectedChatRunning.length === 0 ? (
              <ConversationEmptyState
                icon={<Globe className="size-10" />}
                title="hacker-use"
                description="Enter a URL to analyze for web exploitation vulnerabilities"
              />
            ) : (
              <>
                {messages.map((msg) => (
                  <Message from={msg.role} key={msg._id}>
                    <MessageContent>
                      <MessageResponse>{msg.content}</MessageResponse>
                    </MessageContent>
                  </Message>
                ))}
                {selectedChatRunning.map((investigation) => (
                  <Message
                    from="assistant"
                    key={`running-${investigation._id}`}
                  >
                    <MessageContent className="w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Spinner className="size-3.5" />
                          <span>
                            Investigating ({investigation.agentId.slice(0, 8)}...)
                          </span>
                          {investigation.stepsUsed ? (
                            <span className="text-[11px]">
                              Step {investigation.stepsUsed}
                            </span>
                          ) : null}
                        </div>
                        <Button
                          className="h-auto px-2 py-1 text-[11px]"
                          disabled={Boolean(stoppingAgentIds[investigation.agentId])}
                          onClick={() => {
                            void handleStopInvestigation(investigation)
                          }}
                          type="button"
                          variant="outline"
                        >
                          {stoppingAgentIds[investigation.agentId] ? "Stopping..." : "Stop"}
                        </Button>
                      </div>
                      {investigation.liveBrowserUrl && (
                        <div className="mt-2 overflow-hidden rounded-md border border-border bg-background">
                          <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1">
                            <p className="text-[11px] text-foreground">Current browser URL</p>
                            <a
                              className="text-[11px] text-primary underline"
                              href={investigation.liveBrowserUrl}
                              rel="noreferrer"
                              target="_blank"
                            >
                              Open
                            </a>
                          </div>
                          <p className="truncate border-b border-border px-2 py-1 text-[11px] text-muted-foreground">
                            {investigation.liveBrowserUrl}
                          </p>
                          <div className="w-full aspect-video">
                            <iframe
                              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                              className="border border-transparent transition-all duration-300 w-full h-full"
                              id={`live-browser-iframe-${investigation.agentId}`}
                              loading="lazy"
                              sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
                              src={investigation.liveBrowserUrl}
                              style={{ pointerEvents: "none", aspectRatio: "1111.5 / 1100" }}
                              title="Live Browser Automation"
                            />
                          </div>
                        </div>
                      )}
                    </MessageContent>
                  </Message>
                ))}
              </>
            )}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        <div className="p-4">
          <PromptInput onSubmit={handleSubmit}>
            <PromptInputBody>
              <PromptInputTextarea
                disabled={investigateMutation.isPending}
                placeholder={
                  targetUrl
                    ? `Prompt investigator for ${targetUrl}...`
                    : "Enter a URL to analyze (e.g. https://target.example.com)..."
                }
              />
            </PromptInputBody>
            <PromptInputFooter>
              <div />
              <PromptInputSubmit
                disabled={investigateMutation.isPending}
                status={investigateMutation.isPending ? "submitted" : "ready"}
              />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>
    </div>
  )
}
