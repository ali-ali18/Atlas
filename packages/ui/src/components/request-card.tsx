"use client";

import * as React from "react";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "../lib/utils";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./collapsible";

/** Estado do selo do cabeçalho: espera (âmbar), sucesso, recusa/erro, neutro. */
export type RequestTone = "pending" | "success" | "danger" | "muted";

const BADGE_TONE: Record<RequestTone, string> = {
  pending: "bg-warning/10 text-warning dark:bg-warning/15",
  success: "bg-success/10 text-success dark:bg-success/15",
  danger: "bg-destructive/10 text-destructive dark:bg-destructive/20",
  muted: "bg-foreground/[0.06] text-muted-foreground",
};

/**
 * Classes da ação primária do card: cor de destaque do bot (`--bot-accent`, definida
 * no contêiner do chat/card) com texto legível; sem cor cai no `primary` do tema.
 */
export const REQUEST_PRIMARY_CLASS =
  "bg-(--bot-accent,var(--primary)) text-(--bot-accent-foreground,var(--primary-foreground)) hover:bg-(--bot-accent,var(--primary))/90";

export type RequestCardProps = Omit<React.ComponentProps<"section">, "title"> & {
  /** Ícone ou avatar à esquerda do título (20px de altura). */
  leading?: React.ReactNode;
  title: React.ReactNode;
  /** Selo do estado ("Precisa de aprovação", "Permitido"...). */
  badge?: { tone: RequestTone; label: string };
  description?: React.ReactNode;
  /** Corpo (antes/depois, markdown, campos...). Resolvido, recolhe atrás de `detailsLabel`. */
  children?: React.ReactNode;
  /** Pedido já decidido: some a barra de ações e o corpo recolhe. */
  resolved?: boolean;
  /** Texto do botão que reabre o corpo recolhido. */
  detailsLabel?: string;
  /** Abre o corpo recolhido (teste/estado inicial). */
  defaultDetailsOpen?: boolean;
  /** Linha discreta ao final (resultado: "Aprovada em ..."). */
  note?: React.ReactNode;
  error?: React.ReactNode;
  /** Controle compacto no canto do cabeçalho (ex.: dispensar). */
  headerAction?: React.ReactNode;
  /** Ações principais/secundárias, à esquerda da barra (a primária vem primeiro). */
  actions?: React.ReactNode;
  /** Ações terciárias (ghost), empurradas para a direita da barra. */
  trailing?: React.ReactNode;
};

/**
 * Casca única dos cards interativos do chat (aprovação, login, conexão,
 * proposta, pergunta), no desenho do Grok Bot: cabeçalho com ícone + título +
 * selo de estado, descrição, corpo, barra de ações (primária primeiro,
 * terciárias à direita) e estado resolvido compacto sem ações.
 */
function RequestCard({
  leading,
  title,
  badge,
  description,
  children,
  resolved = false,
  detailsLabel = "Ver detalhes",
  defaultDetailsOpen = false,
  note,
  error,
  headerAction,
  actions,
  trailing,
  className,
  ...props
}: RequestCardProps) {
  const hasActions = !resolved && (actions != null || trailing != null);
  const hasBody = children != null && children !== false;
  return (
    <section
      data-slot="request-card"
      data-state={resolved ? "resolved" : "pending"}
      className={cn(
        "flex w-full max-w-[68ch] min-w-0 flex-col gap-3 rounded-2xl bg-muted/60 p-3 text-sm text-foreground",
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 items-start gap-2">
        {leading != null ? (
          <span
            data-slot="request-card-leading"
            className="flex h-5 shrink-0 items-center justify-center text-muted-foreground [&_svg:not([class*='size-'])]:size-4"
          >
            {leading}
          </span>
        ) : null}
        <p
          data-slot="request-card-title"
          className="m-0 min-w-0 flex-1 text-[15px] leading-5 font-medium [overflow-wrap:anywhere]"
        >
          {title}
        </p>
        {badge ? (
          <span
            data-slot="request-card-badge"
            data-tone={badge.tone}
            role="status"
            className={cn(
              "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs leading-4 font-medium",
              BADGE_TONE[badge.tone],
            )}
          >
            {badge.label}
          </span>
        ) : null}
        {headerAction}
      </div>
      {description ? (
        <p className="m-0 min-w-0 whitespace-pre-line text-sm text-muted-foreground [overflow-wrap:anywhere]">
          {description}
        </p>
      ) : null}
      {hasBody ? (
        resolved ? (
          <Collapsible defaultOpen={defaultDetailsOpen}>
            <CollapsibleTrigger className="group/trigger -ml-1 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-medium text-muted-foreground outline-none hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30">
              {detailsLabel}
              <ChevronRightIcon
                aria-hidden
                className="size-3.5 transition-transform group-aria-expanded/trigger:rotate-90"
              />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-2 flex min-w-0 flex-col gap-2">{children}</div>
            </CollapsibleContent>
          </Collapsible>
        ) : (
          <div className="flex min-w-0 flex-col gap-2">{children}</div>
        )
      ) : null}
      {error ? (
        <p role="alert" className="m-0 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {note ? (
        <p className="m-0 text-xs text-muted-foreground" data-slot="request-card-note">
          {note}
        </p>
      ) : null}
      {hasActions ? (
        <div
          data-slot="request-card-actions"
          className="flex flex-wrap items-center gap-2"
        >
          {actions}
          {trailing != null ? (
            <div className="ml-auto flex flex-wrap items-center gap-2 max-sm:ml-0">
              {trailing}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export { RequestCard };
