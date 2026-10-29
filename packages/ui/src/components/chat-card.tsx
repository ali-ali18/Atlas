"use client";

import * as React from "react";
import { ChevronRightIcon } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils";
import { CHAT_CARD_COPY } from "../lib/chat-card-copy";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./collapsible";

/** Estado do selo do cabeçalho: espera (âmbar), sucesso, recusa/erro, neutro. */
export type ChatCardTone = "pending" | "success" | "danger" | "muted";

const BADGE_TONE: Record<ChatCardTone, string> = {
  pending: "bg-warning/10 text-warning dark:bg-warning/15",
  success: "bg-success/10 text-success dark:bg-success/15",
  danger: "bg-destructive/10 text-destructive dark:bg-destructive/20",
  muted: "bg-foreground/[0.06] text-muted-foreground",
};

/**
 * Casca única de todo card do chat. `card` = cartão com cabeçalho, corpo e ações
 * (aprovação, conexão, proposta, e-mail, painel). `activity` = linha compacta de
 * atividade (ferramenta, skill, anexo, lista de tarefas, código executado).
 * Mesma pele nos dois: cantos `rounded-2xl`, sem borda, fundo `bg-muted/60`, largura
 * máxima de 68 caracteres. Card novo no chat começa aqui.
 */
const chatCardVariants = cva(
  "min-w-0 rounded-2xl bg-muted/60 text-sm text-foreground",
  {
    variants: {
      variant: {
        card: "flex w-full max-w-[min(68ch,100%)] flex-col gap-3 p-3",
        activity:
          "flex w-fit max-w-[min(68ch,100%)] flex-col justify-center gap-2 px-3 py-2",
      },
    },
    defaultVariants: { variant: "card" },
  },
);

function ChatCard({
  className,
  variant = "card",
  ...props
}: React.ComponentProps<"section"> & VariantProps<typeof chatCardVariants>) {
  return (
    <section
      data-slot="chat-card"
      data-variant={variant}
      className={cn(chatCardVariants({ variant }), className)}
      {...props}
    />
  );
}

/** Ícone (size-4) ou avatar à esquerda do título/texto; 20px de altura. */
function ChatCardLeading({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="chat-card-leading"
      className={cn(
        "flex h-5 shrink-0 items-center justify-center text-muted-foreground [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function ChatCardBadge({
  tone,
  label,
}: {
  tone: ChatCardTone;
  label: string;
}) {
  return (
    <span
      data-slot="chat-card-badge"
      data-tone={tone}
      role="status"
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs leading-4 font-medium",
        BADGE_TONE[tone],
      )}
    >
      {label}
    </span>
  );
}

/** Cabeçalho do cartão: ícone + título curto + selo de estado + ação compacta. */
function ChatCardHeader({
  leading,
  title,
  badge,
  action,
}: {
  leading?: React.ReactNode;
  title: React.ReactNode;
  badge?: { tone: ChatCardTone; label: string };
  action?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      {leading != null ? <ChatCardLeading>{leading}</ChatCardLeading> : null}
      <p
        data-slot="chat-card-title"
        className="m-0 min-w-0 flex-1 text-sm leading-5 font-medium [overflow-wrap:anywhere]"
      >
        {title}
      </p>
      {badge ? <ChatCardBadge {...badge} /> : null}
      {action}
    </div>
  );
}

/** Linha da variante `activity`: ícone + conteúdo, na altura de uma linha de texto. */
function ChatCardLine({
  leading,
  children,
  trailing,
  className,
}: {
  leading?: React.ReactNode;
  children: React.ReactNode;
  trailing?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="chat-card-line"
      className={cn("flex min-w-0 items-center gap-2", className)}
    >
      {leading != null ? <ChatCardLeading>{leading}</ChatCardLeading> : null}
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">{children}</div>
      {trailing}
    </div>
  );
}

/** Botão que abre/fecha detalhes: o texto troca entre `label` e `openLabel`. */
function ChatCardToggle({
  open,
  label,
  openLabel,
  className,
}: {
  open: boolean;
  label: string;
  openLabel: string;
  className?: string;
}) {
  return (
    <CollapsibleTrigger
      data-slot="chat-card-toggle"
      className={cn(
        "group/trigger inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-medium text-muted-foreground outline-none hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30",
        className,
      )}
    >
      {open ? openLabel : label}
      <ChevronRightIcon
        aria-hidden
        className="size-3.5 transition-transform group-aria-expanded/trigger:rotate-90"
      />
    </CollapsibleTrigger>
  );
}

type ChatCardDetailsProps = {
  /** Conteúdo recolhido. */
  children: React.ReactNode;
  /** Texto fechado: "Ver detalhes" (padrão) ou "Ver tudo (n)" em lista. */
  label?: string;
  /** Texto aberto. */
  openLabel?: string;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Com `summary`, o botão fica no fim da linha dele (ex.: "Executou código · 1,2 s"). */
  summary?: React.ReactNode;
  className?: string;
};

/** Seção recolhível do card (mesmo vocabulário em todos: Ver detalhes / Mostrar menos). */
function ChatCardDetails({
  children,
  label = CHAT_CARD_COPY.details,
  openLabel = CHAT_CARD_COPY.less,
  open,
  defaultOpen = false,
  onOpenChange,
  summary,
  className,
}: ChatCardDetailsProps) {
  const [inner, setInner] = React.useState(defaultOpen);
  const isOpen = open ?? inner;
  return (
    <Collapsible
      open={isOpen}
      onOpenChange={(next) => {
        setInner(next);
        onOpenChange?.(next);
      }}
      className={cn("min-w-0", className)}
    >
      {summary != null ? (
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1">{summary}</div>
          <ChatCardToggle label={label} open={isOpen} openLabel={openLabel} />
        </div>
      ) : (
        <ChatCardToggle
          className="-ml-1"
          label={label}
          open={isOpen}
          openLabel={openLabel}
        />
      )}
      <CollapsibleContent>
        <div className="mt-2 flex min-w-0 flex-col gap-2">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Barra de ações: primária e secundárias à esquerda, terciárias (`trailing`) à direita. */
function ChatCardActions({
  children,
  trailing,
}: {
  children?: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <div
      data-slot="chat-card-actions"
      className="flex flex-wrap items-center gap-2"
    >
      {children}
      {trailing != null ? (
        <div className="ml-auto flex flex-wrap items-center gap-2 max-sm:ml-0">
          {trailing}
        </div>
      ) : null}
    </div>
  );
}

/** Erro do card, em caixa padrão (tom `destructive`). */
function ChatCardError({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      data-slot="chat-card-error"
      className="m-0 rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {children}
    </p>
  );
}

export {
  ChatCard,
  ChatCardActions,
  ChatCardBadge,
  ChatCardDetails,
  ChatCardError,
  ChatCardHeader,
  ChatCardLeading,
  ChatCardLine,
  ChatCardToggle,
  chatCardVariants,
};
