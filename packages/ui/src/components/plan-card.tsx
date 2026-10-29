"use client";

import * as React from "react";
import {
  CheckIcon,
  CircleIcon,
  ListChecksIcon,
  MessageCircleQuestionIcon,
  PencilLineIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { cn } from "../lib/utils";

import { Button } from "./button";
import { ButtonGroup } from "./button-group";
import { RequestCard, REQUEST_PRIMARY_CLASS, type RequestTone } from "./request-card";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";
import { useUiCopy, type UiCopy } from "./ui-copy";

export type PlanCardStepKind = "read" | "write" | "ask" | "other";
export type PlanCardStep = { text: string; kind: PlanCardStepKind };
/** `adjusted`: o usuário pediu mudanças em vez de aprovar (a decisão chega como "rejeitado" com o desfecho `ajuste pedido`). */
export type PlanCardStatus = "pending" | "approved" | "adjusted" | "cancelled" | "failed";

export type PlanCardProps = {
  title: string;
  steps: readonly PlanCardStep[];
  /** O que o bot ainda precisa saber do usuário. */
  needs?: readonly string[];
  risks?: string;
  status?: PlanCardStatus;
  approveLabel?: string;
  adjustLabel?: string;
  cancelLabel?: string;
  disabled?: boolean;
  className?: string;
  onApprove?: () => void;
  onAdjust?: () => void;
  onCancel?: () => void;
};

const KIND_ICON: Record<PlanCardStepKind, { icon: typeof SearchIcon; label: (copy: UiCopy) => string }> = {
  read: { icon: SearchIcon, label: (copy) => copy.planKindRead },
  write: { icon: PencilLineIcon, label: (copy) => copy.planKindWrite },
  ask: { icon: MessageCircleQuestionIcon, label: (copy) => copy.planKindAsk },
  other: { icon: CircleIcon, label: (copy) => copy.planKindOther },
};

function badgeFor(status: PlanCardStatus, copy: UiCopy): { tone: RequestTone; label: string } {
  if (status === "approved") return { tone: "success", label: copy.planApproved };
  if (status === "adjusted") return { tone: "muted", label: copy.planAdjusted };
  if (status === "cancelled") return { tone: "muted", label: copy.planCancelled };
  if (status === "failed") return { tone: "danger", label: copy.planFailed };
  return { tone: "pending", label: copy.cardNeedsYou };
}

/** Botão do grupo: no celular só o ícone (nome no tooltip); de md em diante ícone e texto. */
function GroupAction({ icon: Icon, label, onClick, disabled }: { icon: typeof XIcon; label: string; onClick?: () => void; disabled?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button aria-label={label} className="max-md:w-8 max-md:px-0" disabled={disabled} onClick={onClick} size="sm" type="button" variant="secondary">
            <Icon aria-hidden />
            <span className="max-md:hidden">{label}</span>
          </Button>
        }
      />
      <TooltipContent className="md:hidden">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Plano proposto antes de uma tarefa grande: passos numerados com um ícone por tipo (leitura, altera dados,
 * pergunta), o que o bot ainda precisa saber e os riscos. Aprovar o plano NÃO aprova as ações: cada escrita
 * ainda pede confirmação, como sempre (o subtítulo diz isso).
 */
function PlanCard({ title, steps, needs, risks, status = "pending", approveLabel, adjustLabel, cancelLabel, disabled = false, className, onApprove, onAdjust, onCancel }: PlanCardProps) {
  const copy = useUiCopy();
  const resolved = status !== "pending";
  return (
    <RequestCard
      className={cn("plan-card", className)}
      data-plan-card
      data-plan-status={status}
      badge={badgeFor(status, copy)}
      description={resolved ? undefined : copy.planNote}
      leading={<ListChecksIcon aria-hidden />}
      resolved={resolved}
      detailsLabel={copy.planViewPlan}
      title={title}
      actions={
        <>
          <Button className={REQUEST_PRIMARY_CLASS} disabled={disabled} onClick={onApprove} size="sm" type="button">
            <CheckIcon aria-hidden />
            {approveLabel ?? copy.planApprove}
          </Button>
          <ButtonGroup>
            {onAdjust ? <GroupAction disabled={disabled} icon={PencilLineIcon} label={adjustLabel ?? copy.planAdjust} onClick={onAdjust} /> : null}
            <GroupAction disabled={disabled} icon={XIcon} label={cancelLabel ?? copy.cancel} onClick={onCancel} />
          </ButtonGroup>
        </>
      }
    >
      <ol className="m-0 flex list-none flex-col gap-1.5 p-0" data-plan-steps>
        {steps.map((step, index) => {
          const { icon: Icon, label: labelOf } = KIND_ICON[step.kind] ?? KIND_ICON.other;
          const label = labelOf(copy);
          return (
            <li className="flex min-w-0 items-start gap-2" key={`${index}-${step.text}`}>
              <span className="w-4 shrink-0 text-right text-xs leading-5 text-muted-foreground tabular-nums">{index + 1}.</span>
              <Icon aria-label={label} className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" data-step-kind={step.kind} role="img" />
              <span className="min-w-0 text-sm leading-5 [overflow-wrap:anywhere]">{step.text}</span>
            </li>
          );
        })}
      </ol>
      {needs && needs.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-1" data-plan-needs>
          <p className="m-0 text-xs font-medium text-muted-foreground">{copy.planNeeds}</p>
          <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5 text-sm marker:text-muted-foreground">
            {needs.map((need, index) => (
              <li className="[overflow-wrap:anywhere]" key={`${index}-${need}`}>
                {need}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {risks ? (
        <p className="m-0 text-xs text-muted-foreground [overflow-wrap:anywhere]" data-plan-risks>
          <span className="font-medium">{copy.planRisk} </span>
          {risks}
        </p>
      ) : null}
    </RequestCard>
  );
}

export { PlanCard };
