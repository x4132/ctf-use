import { ConvexProvider, ConvexReactClient } from "convex/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { httpBatchLink } from "@trpc/client"
import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import App from "./App.tsx"
import { trpc } from "./lib/trpc"

function Root() {
  const env = import.meta.env as Record<string, string | undefined>
  const convexUrl = env.VITE_CONVEX_URL ?? env.CONVEX_URL
  if (!convexUrl) {
    throw new Error(
      "Missing Convex URL. Set VITE_CONVEX_URL or CONVEX_URL in your root env file.",
    )
  }

  const [convexClient] = useState(() => new ConvexReactClient(convexUrl))
  const [queryClient] = useState(() => new QueryClient())
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: "/trpc",
        }),
      ],
    }),
  )

  return (
    <ConvexProvider client={convexClient}>
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </trpc.Provider>
    </ConvexProvider>
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
