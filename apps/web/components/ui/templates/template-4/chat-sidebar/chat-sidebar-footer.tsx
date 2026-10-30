"use client"

import { useState } from "react"
import {
  Book,
  ShieldCheckIcon,
  MoreHorizontalIcon,
  PlusIcon,
  Settings,
  SquareArrowRightExit,
  StoreIcon,
} from "lucide-react"

import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@workspace/ui/components/sidebar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { NewChatMenu } from "./new-chat-menu"
import { UserAvatar as GradientAvatar } from "@workspace/ui/components/gradient-avatar"
import { useT } from "@/lib/i18n/provider"
import { authClient } from "@/lib/auth-client"
import { signOutAndRedirect } from "@/lib/sign-out"

export function UserAvatar({ image, seed, name, email, size }: { image?: string | null; seed: string; name?: string | null; email?: string | null; size: "small" | "large" }) {
  return <GradientAvatar email={email} image={image} name={name} seed={seed} size={size === "large" ? 36 : 28} />
}

export function ChatSidebarFooter({
  onOpenMarketplace,
  onOpenSettings,
  onOpenAutonomy,
  onStartCreate,
  onStartCreateGroup,
}: {
  onOpenMarketplace?: () => void
  onOpenSettings?: () => void
  onOpenAutonomy?: () => void
  onStartCreate?: () => void
  onStartCreateGroup?: () => void
}) {
  const t = useT()
  const { open } = useSidebar()
  const { data: session } = authClient.useSession()
  const [logoutError, setLogoutError] = useState("")
  const name = session?.user.name || session?.user.email || t("sidebar.account")
  const image = session?.user.image

  async function signOut() {
    setLogoutError("")
    const failure = await signOutAndRedirect()
    if (failure) setLogoutError(failure)
  }

  // Rail minimizado: botões centralizados e maiores, como na referência.
  // O SidebarMenuButton colapsado (size-8) deixaria tudo deslocado e pequeno.
  // O "+" de criar bot desce para o footer; o search não renderiza.
  if (!open) {
    return (
      <div className="flex flex-col items-center gap-2 py-1">
        <NewChatMenu
          align="start"
          onNewBot={() => onStartCreate?.()}
          onNewGroup={() => onStartCreateGroup?.()}
          side="right"
          trigger={
            <button
              aria-label={t("sidebar.newBotOrGroup")}
              className="grid size-11 place-items-center rounded-2xl text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
              title={t("sidebar.newBotOrGroup")}
              type="button"
            >
              <PlusIcon className="size-5" />
            </button>
          }
        />
        <button
          aria-label={t("sidebar.marketplace")}
          className="grid size-11 place-items-center rounded-2xl text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
          onClick={onOpenMarketplace}
          title={t("sidebar.marketplace")}
          type="button"
        >
          <StoreIcon className="size-5" />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger
            className="grid size-11 cursor-pointer place-items-center rounded-2xl transition-colors hover:bg-sidebar-accent/60"
            title={name}
          >
            <UserAvatar image={image} email={session?.user.email} name={session?.user.name} seed={session?.user.email || name} size="large" />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={onOpenSettings}>
                <Settings /> {t("sidebar.settings")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onOpenAutonomy}>
                <ShieldCheckIcon /> {t("sidebar.autonomy")}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => void signOut()}>
                <SquareArrowRightExit /> {t("sidebar.signOut")}
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Book /> {t("sidebar.documentation")}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            {logoutError && <p className="px-2 py-1 text-xs text-destructive" role="alert">{logoutError}</p>}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    )
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton onClick={onOpenMarketplace} tooltip={t("sidebar.marketplace")}>
          <StoreIcon />
          <span>{t("sidebar.marketplace")}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
      <SidebarMenuItem>
        <DropdownMenu>
          <SidebarMenuButton
            className="h-auto py-2 group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:p-0!"
            tooltip={name}
            render={<DropdownMenuTrigger />}
          >
            <UserAvatar image={image} email={session?.user.email} name={session?.user.name} seed={session?.user.email || name} size="small" />
            <span className="flex min-w-0 flex-1 flex-col group-data-[collapsible=icon]:hidden">
              <span className="truncate text-sm font-medium">{name}</span>
              <span className="truncate text-xs text-sidebar-foreground/60">
                {session?.user.email || ""}
              </span>
            </span>
            <MoreHorizontalIcon className="ml-auto size-4 text-sidebar-foreground/60 group-data-[collapsible=icon]:hidden" />
          </SidebarMenuButton>
          <DropdownMenuContent>
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={onOpenSettings}>
                <Settings /> {t("sidebar.settings")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onOpenAutonomy}>
                <ShieldCheckIcon /> {t("sidebar.autonomy")}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => void signOut()}>
                <SquareArrowRightExit /> {t("sidebar.signOut")}
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Book /> {t("sidebar.documentation")}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            {logoutError && <p className="px-2 py-1 text-xs text-destructive" role="alert">{logoutError}</p>}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
