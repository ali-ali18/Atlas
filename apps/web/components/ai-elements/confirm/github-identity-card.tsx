"use client";

import { ExternalLinkIcon } from "lucide-react";
import { githubIdentityCardText, type GithubIdentityCardInfo } from "@workspace/shared";
import { buttonVariants } from "@workspace/ui/components/button";
import { ConfirmCard } from "./confirm-card";

export type GithubIdentityCardProps = {
  info: GithubIdentityCardInfo;
  status?: "pending" | "approved" | "rejected";
  disabled?: boolean;
  onDone?: () => void;
  onCancel?: () => void;
};

/**
 * O bot quer escrever no GitHub como o app, mas o repositório não está na instalação (ou faltam
 * permissões). Nada foi enviado: instalar/aceitar no GitHub e tocar em Pronto (a ação é refeita).
 */
export function GithubIdentityCard({ info, status = "pending", disabled, onDone, onCancel }: GithubIdentityCardProps) {
  const text = githubIdentityCardText(info);
  const external = Boolean(info.installUrl?.startsWith("https://"));
  return (
    <ConfirmCard
      title={text.title}
      description={text.description}
      status={status}
      confirmLabel={text.confirmLabel}
      cancelLabel="Cancelar"
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
