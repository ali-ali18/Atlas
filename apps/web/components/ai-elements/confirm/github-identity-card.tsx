"use client";

import { ExternalLinkIcon } from "lucide-react";
import type { GithubIdentityCardInfo } from "@workspace/shared";
import { buttonVariants } from "@workspace/ui/components/button";
import { useTranslations } from "@/lib/i18n/provider";
import type { MessageKey, Translator } from "@/lib/i18n/translator";
import { ConfirmCard } from "./confirm-card";

export type GithubIdentityCardProps = {
  info: GithubIdentityCardInfo;
  status?: "pending" | "approved" | "rejected" | "failed";
  disabled?: boolean;
  onDone?: () => void;
  onCancel?: () => void;
};

const REASON_KEYS = {
  not_installed: "aiElements.github.reason.not_installed",
  suspended: "aiElements.github.reason.suspended",
  app_missing: "aiElements.github.reason.app_missing",
  token_failed: "aiElements.github.reason.token_failed",
  no_permission: "aiElements.github.reason.no_permission",
} as const satisfies Record<GithubIdentityCardInfo["reason"], MessageKey>

/** Textos do cartão no idioma da tela (mesma regra do `githubIdentityCardText` do shared, que só tem pt-BR). */
export function githubIdentityText(info: GithubIdentityCardInfo, { t }: Translator) {
  const as = info.appName ? t("aiElements.github.as", { app: info.appName }) : t("aiElements.github.asDefault")
  const repo = info.repo ?? t("aiElements.github.repoDefault")
  const accept = info.reason === "no_permission"
  return {
    title: accept ? t("aiElements.github.title.permissions") : t("aiElements.github.title.notInstalled"),
    description: t(REASON_KEYS[info.reason], { repo, as }),
    installLabel: info.installUrl
      ? info.reason === "not_installed"
        ? t("aiElements.github.install.not_installed")
        : accept
          ? t("aiElements.github.install.accept")
          : t("aiElements.github.install.open")
      : null,
    confirmLabel: accept ? t("aiElements.github.confirm.accepted") : t("aiElements.github.confirm.installed"),
  }
}

/**
 * O bot quer escrever no GitHub como o app, mas o repositório não está na instalação (ou faltam
 * permissões). Nada foi enviado: instalar/aceitar no GitHub e tocar em Pronto (a ação é refeita).
 */
export function GithubIdentityCard({ info, status = "pending", disabled, onDone, onCancel }: GithubIdentityCardProps) {
  const translator = useTranslations();
  const text = githubIdentityText(info, translator);
  const external = Boolean(info.installUrl?.startsWith("https://"));
  return (
    <ConfirmCard
      title={text.title}
      description={text.description}
      status={status}
      confirmLabel={text.confirmLabel}
      cancelLabel={translator.t("aiElements.github.cancel")}
      disabled={disabled}
      onConfirm={onDone}
      onCancel={onCancel}
    >
      {status === "pending" && info.installUrl && text.installLabel ? (
        <a
          className={buttonVariants({ variant: "outline", size: "sm" })}
          data-slot="github-install-link"
          href={info.installUrl}
          {...(external ? { rel: "noopener noreferrer", target: "_blank" } : {})}
        >
          {text.installLabel}
          {external ? <ExternalLinkIcon aria-hidden className="size-3.5" /> : null}
        </a>
      ) : null}
    </ConfirmCard>
  );
}
