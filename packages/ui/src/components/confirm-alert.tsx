"use client";

import * as React from "react";
import { CheckIcon, ShieldAlertIcon, XIcon } from "lucide-react";

import { Button } from "./button";
import { RequestCard, REQUEST_PRIMARY_CLASS, type RequestCardProps } from "./request-card";
import { useUiCopy, type UiCopy } from "./ui-copy";

export type ConfirmStatus = "pending" | "approved" | "rejected" | "failed";

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

function StatusIcon({ status, copy }: { status: ConfirmStatus; copy: UiCopy }) {
  if (status === "approved") return <CheckIcon aria-label={copy.confirmApproved} />;
  if (status === "rejected") return <XIcon aria-label={copy.confirmNotApproved} />;
  if (status === "failed") return <XIcon aria-label={copy.confirmFailed} />;
  return <ShieldAlertIcon aria-label={copy.confirmAttention} />;
}

function badgeFor(status: ConfirmStatus, copy: UiCopy) {
  if (status === "approved") return { tone: "success", label: copy.confirmApproved } as const;
  if (status === "rejected") return { tone: "danger", label: copy.confirmRejected } as const;
  if (status === "failed") return { tone: "danger", label: copy.confirmFailed } as const;
  return { tone: "pending", label: copy.cardNeedsYou } as const;
}

/**
 * Pedido de confirmação no desenho do Grok Bot: primária primeiro, extras em
 * secundário e a recusa como terciária à direita; decidido, só o selo fica.
 */
function ConfirmAlert({
  title,
  description,
  status = "pending",
  confirmLabel,
  cancelLabel,
  editLabel,
  alwaysLabel,
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
  const copy = useUiCopy();
  const resolved = status !== "pending";
  return (
    <RequestCard
      {...props}
      badge={badgeFor(status, copy)}
      description={description}
      leading={leading ?? <StatusIcon copy={copy} status={status} />}
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
            {confirmLabel ?? copy.confirm}
          </Button>
          {onEdit ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={disabled}
              onClick={onEdit}
              type="button"
            >
              {editLabel ?? copy.edit}
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
              {alwaysLabel ?? copy.confirmAlways}
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
          {cancelLabel ?? copy.cancel}
        </Button>
      }
    >
      {children}
    </RequestCard>
  );
}

export { ConfirmAlert };
