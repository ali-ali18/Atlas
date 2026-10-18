import { magicLinkClient } from "better-auth/client/plugins"
import { createAuthClient } from "better-auth/react"

type AuthClient = ReturnType<typeof createAuthClient<{ plugins: [ReturnType<typeof magicLinkClient>] }>>

export const authClient: AuthClient = createAuthClient({
  plugins: [magicLinkClient()],
})
