"use client"

import { useEffect, useState } from "react"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { GithubMarkIcon } from "@/components/icons/github-mark"
import { githubAppViewState } from "@/components/settings/github-app-state"
import { openSettingsModal } from "@/components/settings/settings-url"
import { useTranslations } from "@/lib/i18n/provider"
import { GITHUB_APP_INSTALL_PATH, getGithubAppStatus, type GithubAppStatus } from "@/lib/atlas-api"

/**
 * Cartão do GitHub no Marketplace: o caminho recomendado é instalar o app (sem token pessoal);
 * o token pessoal continua abaixo como alternativa. Some quando o app não existe e o usuário
 * não é o dono (nada para fazer).
 */
export function GithubAppCallout({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const { t } = useTranslations()
  const [status, setStatus] = useState<GithubAppStatus | null>(null)

  useEffect(() => {
    let alive = true
    getGithubAppStatus()
      .then((value) => alive && setStatus(value))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  const state = githubAppViewState(status)
  if (state === "loading" || state === "waiting-owner") return null

  const installedOn = status?.installations[0]?.accountLogin
  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-xl border border-border/60 px-4 py-3"
      data-slot="github-app-callout"
    >
      <GithubMarkIcon className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 basis-48">
        <p className="text-sm font-medium">
          {state === "installed" ? t("marketplace.github.installedOn", { account: installedOn ?? "" }) : t("marketplace.github.install")}
        </p>
        <p className="text-xs text-muted-foreground">
          {state === "owner-create"
            ? t("marketplace.github.ownerCreate")
            : state === "installed"
              ? t("marketplace.github.manage")
              : t("marketplace.github.choose")}
        </p>
      </div>
      {state === "install" ? (
        <a className={buttonVariants({ size: "sm" })} href={GITHUB_APP_INSTALL_PATH}>
          {t("marketplace.github.installButton")}
        </a>
      ) : (
        <Button
          onClick={() => {
            onOpenSettings?.()
            openSettingsModal("conexoes")
          }}
          size="sm"
          variant="outline"
        >
          {state === "owner-create" ? t("marketplace.github.createApp") : t("marketplace.github.manageButton")}
        </Button>
      )}
    </div>
  )
}
