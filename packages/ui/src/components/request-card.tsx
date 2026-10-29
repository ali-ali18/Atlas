"use client";

import * as React from "react";

import {
  ChatCard,
  ChatCardActions,
  ChatCardDetails,
  ChatCardError,
  ChatCardHeader,
  type ChatCardTone,
} from "./chat-card";
import { CHAT_CARD_COPY } from "../lib/chat-card-copy";

/** Estado do selo do cabeçalho: espera (âmbar), sucesso, recusa/erro, neutro. */
export type RequestTone = ChatCardTone;

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
  /** Selo do estado ("Precisa de você", "Permitido"...). */
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
 * Card interativo do chat (aprovação, login, conexão, proposta, pergunta) sobre a
 * casca `ChatCard`: cabeçalho com ícone + título + selo de estado, descrição, corpo,
 * barra de ações (primária primeiro, terciárias à direita) e estado resolvido
 * compacto sem ações.
 */
function RequestCard({
  leading,
  title,
  badge,
  description,
  children,
  resolved = false,
  detailsLabel = CHAT_CARD_COPY.details,
  defaultDetailsOpen = false,
  note,
  error,
  headerAction,
  actions,
  trailing,
  ...props
}: RequestCardProps) {
  const hasActions = !resolved && (actions != null || trailing != null);
  const hasBody = children != null && children !== false;
  return (
    <ChatCard
      data-slot="request-card"
      data-state={resolved ? "resolved" : "pending"}
      {...props}
    >
      <ChatCardHeader
        action={headerAction}
        badge={badge}
        leading={leading}
        title={title}
      />
      {description ? (
        <p className="m-0 min-w-0 whitespace-pre-line text-sm text-muted-foreground [overflow-wrap:anywhere]">
          {description}
        </p>
      ) : null}
      {hasBody ? (
        resolved ? (
          <ChatCardDetails defaultOpen={defaultDetailsOpen} label={detailsLabel}>
            {children}
          </ChatCardDetails>
        ) : (
          <div className="flex min-w-0 flex-col gap-2">{children}</div>
        )
      ) : null}
      {error ? <ChatCardError>{error}</ChatCardError> : null}
      {note ? (
        <p className="m-0 text-xs text-muted-foreground" data-slot="request-card-note">
          {note}
        </p>
      ) : null}
      {hasActions ? (
        <ChatCardActions trailing={trailing}>{actions}</ChatCardActions>
      ) : null}
    </ChatCard>
  );
}

export { RequestCard };
