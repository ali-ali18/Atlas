"use client";

import * as React from "react";
import { CheckIcon, ShieldAlertIcon, XIcon } from "lucide-react";

import { Button } from "./button";
import { RequestCard, REQUEST_PRIMARY_CLASS, type RequestCardProps } from "./request-card";

export type ConfirmStatus = "pending" | "approved" | "rejected";

export type ConfirmAlertProps = Omit<
  RequestCardProps,
  "badge" | "resolved" | "actions" | "trailing" | "title" | "description"
> & {
  title: string;
  description?: string;
  status?: ConfirmStatus;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Terceira ação (opcional): "Editar" volta ao campo sem descartar. */
  editLabel?: string;
  /** Ação extra (opcional): "Não perguntar mais para isto". */
  alwaysLabel?: string;
  disabled?: boolean;
  /** Ação irreversível (ex.: apagar): o botão de confirmar usa o estilo destrutivo. */
  destructive?: boolean;
  onConfirm?: () => void;
  onCancel?: () => void;
  onEdit?: () => void;
  onAlways?: () => void;
};

function StatusIcon({ status }: { status: ConfirmStatus }) {
  if (status === "approved") return <CheckIcon aria-label="Aprovado" />;
  if (status === "rejected") return <XIcon aria-label="Não aprovado" />;
  return <ShieldAlertIcon aria-label="Atenção" />;
}

const BADGE = {
  pending: { tone: "pending", label: "Precisa de aprovação" },
  approved: { tone: "success", label: "Aprovado" },
  rejected: { tone: "danger", label: "Recusado" },
} as const;

/**
 * Pedido de confirmação no desenho do Grok Bot: primária primeiro, extras em
 * secundário e a recusa como terciária à direita; decidido, só o selo fica.
 */
function ConfirmAlert({
  title,
  description,
  status = "pending",
  confirmLabel = "Confirmar",
  cancelLabel = "Cancelar",
  editLabel = "Editar",
  alwaysLabel = "Não perguntar mais para isto",
  disabled = false,
  destructive = false,
  onConfirm,
  onCancel,
  onEdit,
  onAlways,
  leading,
  children,
  ...props
}: ConfirmAlertProps) {
  const resolved = status !== "pending";
  return (
    <RequestCard
      {...props}
      badge={BADGE[status]}
      description={description}
      leading={leading ?? <StatusIcon status={status} />}
      resolved={resolved}
      title={title}
      actions={
        <>
          <Button
            className={destructive ? undefined : REQUEST_PRIMARY_CLASS}
            size="sm"
            variant={destructive ? "destructive" : "default"}
            disabled={disabled}
            onClick={onConfirm}
            type="button"
          >
            {confirmLabel}
          </Button>
          {onEdit ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={disabled}
              onClick={onEdit}
              type="button"
            >
              {editLabel}
            </Button>
          ) : null}
          {onAlways ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={disabled}
              onClick={onAlways}
              type="button"
            >
              {alwaysLabel}
            </Button>
          ) : null}
        </>
      }
      trailing={
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={onCancel}
          type="button"
        >
          {cancelLabel}
        </Button>
      }
    >
      {children}
    </RequestCard>
  );
}

export { ConfirmAlert };
