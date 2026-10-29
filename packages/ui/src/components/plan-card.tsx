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

const KIND_ICON: Record<PlanCardStepKind, { icon: typeof SearchIcon; label: string }> = {
  read: { icon: SearchIcon, label: "Leitura" },
  write: { icon: PencilLineIcon, label: "Altera dados" },
  ask: { icon: MessageCircleQuestionIcon, label: "Pergunta" },
  other: { icon: CircleIcon, label: "Passo" },
};

const BADGE: Record<PlanCardStatus, { tone: RequestTone; label: string }> = {
  pending: { tone: "pending", label: "Precisa de você" },
  approved: { tone: "success", label: "Plano aprovado" },
  adjusted: { tone: "muted", label: "Ajuste pedido" },
  cancelled: { tone: "muted", label: "Cancelado" },
  failed: { tone: "danger", label: "Falhou" },
};

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
function PlanCard({ title, steps, needs, risks, status = "pending", approveLabel = "Aprovar plano", adjustLabel = "Ajustar", cancelLabel = "Cancelar", disabled = false, className, onApprove, onAdjust, onCancel }: PlanCardProps) {
  const resolved = status !== "pending";
  return (
    <RequestCard
      className={cn("plan-card", className)}
      data-plan-card
      data-plan-status={status}
      badge={BADGE[status]}
      description={resolved ? undefined : "Aprovar o plano não aprova as ações: cada alteração ainda pede sua confirmação."}
      leading={<ListChecksIcon aria-hidden />}
      resolved={resolved}
      detailsLabel="Ver plano"
      title={title}
      actions={
        <>
          <Button className={REQUEST_PRIMARY_CLASS} disabled={disabled} onClick={onApprove} size="sm" type="button">
            <CheckIcon aria-hidden />
            {approveLabel}
          </Button>
          <ButtonGroup>
            {onAdjust ? <GroupAction disabled={disabled} icon={PencilLineIcon} label={adjustLabel} onClick={onAdjust} /> : null}
            <GroupAction disabled={disabled} icon={XIcon} label={cancelLabel} onClick={onCancel} />
          </ButtonGroup>
        </>
      }
    >
      <ol className="m-0 flex list-none flex-col gap-1.5 p-0" data-plan-steps>
        {steps.map((step, index) => {
          const { icon: Icon, label } = KIND_ICON[step.kind] ?? KIND_ICON.other;
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
          <p className="m-0 text-xs font-medium text-muted-foreground">Preciso de</p>
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
          <span className="font-medium">Atenção: </span>
          {risks}
        </p>
      ) : null}
    </RequestCard>
  );
}

export { PlanCard };
