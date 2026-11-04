"use client";

import * as React from "react";
import { ChevronRightIcon } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils";
import { useUiCopy } from "./ui-copy";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./collapsible";

/** Estado do selo do cabeçalho: espera (âmbar), sucesso, recusa/erro, neutro, informação (ex.: "Você assumiu"). */
export type ChatCardTone = "pending" | "success" | "danger" | "muted" | "info";

const BADGE_TONE: Record<ChatCardTone, string> = {
  pending: "bg-warning/10 text-warning dark:bg-warning/15",
  success: "bg-success/10 text-success dark:bg-success/15",
  danger: "bg-destructive/10 text-destructive dark:bg-destructive/20",
  muted: "bg-foreground/[0.06] text-muted-foreground",
  info: "bg-info/10 text-info dark:bg-info/15",
};

/**
 * Casca única de todo card do chat. `card` = cartão com cabeçalho, corpo e ações
 * (aprovação, conexão, proposta, e-mail, painel). `activity` = linha compacta de
 * atividade (ferramenta, skill, anexo, lista de tarefas, código executado).
 * Mesma pele nos dois (referência do dono, 04/11): raio grande `rounded-card-lg` (28px), borda fina
 * `border-border/60`, fundo uniforme `bg-card`, respiro de 20px no cartão e largura máxima de 68
 * caracteres. Card novo no chat começa aqui.
 */
const chatCardVariants = cva(
  "min-w-0 rounded-card-lg border border-border/60 bg-card text-sm text-foreground",
  {
    variants: {
      variant: {
        card: "flex w-full max-w-[min(68ch,100%)] flex-col gap-3 p-5",
        activity:
          "flex w-fit max-w-[min(68ch,100%)] flex-col justify-center gap-2 px-4 py-2.5",
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

/** Ícone do cabeçalho do cartão dentro de um quadradinho arredondado de fundo muted (24px). */
function ChatCardIcon({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="chat-card-icon"
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    />
  );
}

/** Selo colorido só quando precisa chamar atenção (espera, erro); o resto vira texto muted ao lado do rótulo. */
export function isAttentionTone(tone: ChatCardTone): boolean {
  return tone === "pending" || tone === "danger";
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

/**
 * Cabeçalho do cartão, em duas linhas (referência do dono, 04/11):
 * 1. ícone no quadradinho + rótulo curto (ex.: "Computador", "Aprovação") + estado em texto muted
 *    ("Concluído") + selo colorido só quando chama atenção + ação compacta (ex.: X);
 * 2. título em negrito numa linha própria (nunca divide a linha com o selo).
 */
function ChatCardHeader({
  leading,
  label,
  title,
  badge,
  action,
}: {
  leading?: React.ReactNode;
  /** Rótulo curto do tipo de cartão (linha de cima). */
  label?: React.ReactNode;
  title: React.ReactNode;
  badge?: { tone: ChatCardTone; label: string };
  action?: React.ReactNode;
}) {
  const attention = badge ? isAttentionTone(badge.tone) : false;
  const quiet = badge && !attention ? badge : undefined;
  const hasTop = leading != null || label != null || badge != null || action != null;
  return (
    <div data-slot="chat-card-header" className="flex min-w-0 flex-col gap-2">
      {hasTop ? (
        <div className="flex min-h-6 min-w-0 items-center gap-2">
          {leading != null ? <ChatCardIcon>{leading}</ChatCardIcon> : null}
          {label != null ? (
            <span data-slot="chat-card-label" className="min-w-0 truncate text-sm font-medium text-foreground">
              {label}
            </span>
          ) : null}
          {quiet ? (
            <span
              data-slot="chat-card-badge"
              data-tone={quiet.tone}
              role="status"
              className={cn("min-w-0 truncate text-sm", quiet.tone === "success" ? "text-muted-foreground" : quiet.tone === "info" ? "text-info" : "text-muted-foreground")}
            >
              {quiet.label}
            </span>
          ) : null}
          <span className="flex-1" />
          {badge && attention ? <ChatCardBadge {...badge} /> : null}
          {action}
        </div>
      ) : null}
      <p
        data-slot="chat-card-title"
        className="m-0 min-w-0 text-base leading-snug font-semibold [overflow-wrap:anywhere]"
      >
        {title}
      </p>
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
  label: labelProp,
  openLabel: openLabelProp,
  open,
  defaultOpen = false,
  onOpenChange,
  summary,
  className,
}: ChatCardDetailsProps) {
  const copy = useUiCopy();
  const label = labelProp ?? copy.cardDetails;
  const openLabel = openLabelProp ?? copy.cardLess;
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

/** Filhos em lista, abrindo fragmentos (os cards passam as ações num `<>…</>`). */
function flattenChildren(children: React.ReactNode): React.ReactNode[] {
  return React.Children.toArray(children).flatMap((child) =>
    React.isValidElement<{ children?: React.ReactNode }>(child) && child.type === React.Fragment
      ? flattenChildren(child.props.children)
      : [child],
  );
}

/** Barra de ações: pílulas alinhadas à direita com a principal na ponta; terciárias (`trailing`) à esquerda. */
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
      className="flex flex-wrap items-center justify-end gap-2"
    >
      {trailing != null ? (
        <div className="mr-auto flex flex-wrap items-center gap-2">
          {trailing}
        </div>
      ) : null}
      {/* Pílulas à direita, a principal na ponta. Quem chama passa a principal primeiro; a ordem vira ao contrário
          no DOM (não só no CSS) para o foco do teclado seguir a ordem que se vê. */}
      <div className="flex flex-wrap items-center justify-end gap-2">{flattenChildren(children).reverse()}</div>
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
  ChatCardIcon,
  ChatCardLeading,
  ChatCardLine,
  ChatCardToggle,
  chatCardVariants,
};
