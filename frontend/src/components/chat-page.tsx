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
import { trpc } from "@/lib/trpc"
import { useChatStore } from "@/stores/chat"
import { Globe } from "lucide-react"

export function ChatPage() {
  const messages = useChatStore((s) => s.messages)
  const addMessage = useChatStore((s) => s.addMessage)

  const sendMutation = trpc.chat.send.useMutation({
    onSuccess: (data) => {
      addMessage({ id: data.id, role: data.role, content: data.content })
    },
    onError: () => {
      addMessage({
        id: crypto.randomUUID(),
        role: "assistant",
        content: "Something went wrong. Please try again.",
      })
    },
  })

  const handleSubmit = (message: PromptInputMessage) => {
    const text = message.text.trim()
    if (!text || sendMutation.isPending) return

    addMessage({
      id: crypto.randomUUID(),
      role: "user",
      content: text,
    })

    sendMutation.mutate({ message: text })
  }

  return (
    <div className="mx-auto flex h-screen max-w-3xl flex-col">
      <Conversation className="flex-1">
        <ConversationContent>
          {messages.length === 0 ? (
            <ConversationEmptyState
              icon={<Globe className="size-10" />}
              title="hacker-use"
              description="Enter a URL to analyze for web exploitation vulnerabilities"
            />
          ) : (
            messages.map((msg) => (
              <Message from={msg.role} key={msg.id}>
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
        <PromptInput onSubmit={handleSubmit}>
          <PromptInputBody>
            <PromptInputTextarea placeholder="Enter a URL to analyze (e.g. https://target.example.com)..." />
          </PromptInputBody>
          <PromptInputFooter>
            <div />
            <PromptInputSubmit
              disabled={sendMutation.isPending}
              status={sendMutation.isPending ? "submitted" : "ready"}
            />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  )
}
