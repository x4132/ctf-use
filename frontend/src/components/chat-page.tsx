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
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  usePromptInputController,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input"
import { Button } from "@/components/ui/button"
import { trpc } from "@/lib/trpc"
import { api } from "../../../convex/_generated/api"
import type { Doc, Id } from "../../../convex/_generated/dataModel"
import { useMutation, useQuery } from "convex/react"
import { Globe } from "lucide-react"
import { useEffect, useRef, useState } from "react"

const DEFAULT_CHAT_TITLE = "New chat"

type ChatId = Id<"chats">
type ChatDoc = Doc<"chats">

function PromptControllerBridge({
  controllerRef,
}: {
  controllerRef: React.RefObject<{ setInput: (v: string) => void } | null>
}) {
  const controller = usePromptInputController()
  useEffect(() => {
    controllerRef.current = { setInput: controller.textInput.setInput }
  }, [controller, controllerRef])
  return null
}

export function ChatPage() {
  const chats = useQuery(api.chats.list)
  const chatList = chats ?? []

  const createChat = useMutation(api.chats.create)
  const renameChat = useMutation(api.chats.rename)
  const removeChat = useMutation(api.chats.remove)
  const sendMessage = trpc.chat.send.useMutation()
  const destroySandbox = trpc.chat.destroy.useMutation()

  const [selectedChatId, setSelectedChatId] = useState<ChatId | null>(null)
  const [renamingChatId, setRenamingChatId] = useState<ChatId | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const isCreatingInitialChatRef = useRef(false)
  const promptControllerRef = useRef<{ setInput: (v: string) => void } | null>(null)

  const activeChatId =
    selectedChatId && chatList.some((chat) => chat._id === selectedChatId)
      ? selectedChatId
      : (chatList[0]?._id ?? null)
  const selectedChat = chatList.find((chat) => chat._id === activeChatId) ?? null
  const messages =
    useQuery(
      api.messages.listByChat,
      activeChatId ? { chatId: activeChatId } : "skip",
    ) ?? []

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
    try {
      // Destroy sandbox if one exists for this chat
      await destroySandbox.mutateAsync({ chatId })
    } catch {
      // best-effort — sandbox may not exist
    }

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

    // Fire agent in background — backend streams all messages (user + assistant) to Convex via OpenCode events
    sendMessage.mutateAsync({ chatId, message: text }).catch(console.error)
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
              messages.map((msg) => (
                <Message from={msg.role} key={msg._id}>
                  <MessageContent>
                    <MessageResponse>{msg.content}</MessageResponse>
                  </MessageContent>
                </Message>
              ))
            )}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

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
                <PromptInputSubmit
                  disabled={sendMessage.isPending}
                  status={sendMessage.isPending ? "submitted" : "ready"}
                />
              </PromptInputFooter>
            </PromptInput>
          </PromptInputProvider>
        </div>
      </div>
    </div>
  )
}
