"use client";

import type { ReactNode } from "react";
import {
  ConfirmAlert,
  type ConfirmStatus,
} from "@workspace/ui/components/confirm-alert";

export type ConfirmCardProps = {
  title: string;
  description?: string;
  status?: ConfirmStatus;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Terceira ação: "Editar" volta ao campo (opcional, não quebra callers). */
  editLabel?: string;
  /** Ação extra ("Não perguntar mais para isto"): só aparece com `onAlways`. */
  alwaysLabel?: string;
  /** Desabilita os botões (ex: durante o PATCH, evita duplo confirm). */
  disabled?: boolean;
  /** Ação irreversível: confirmar com estilo destrutivo. */
  destructive?: boolean;
  /** Ícone/avatar à esquerda do título (padrão: ícone do estado). */
  leading?: ReactNode;
  error?: ReactNode;
  /** Linha discreta ao final (resultado da decisão). */
  note?: ReactNode;
  /** Texto do botão que reabre o corpo depois de decidido. */
  detailsLabel?: string;
  /** Conteúdo extra abaixo da descrição (ex: antes/depois). */
  children?: ReactNode;
  onConfirm?: () => void;
  onCancel?: () => void;
  onEdit?: () => void;
  onAlways?: () => void;
};

export function ConfirmCard({
  title,
  description,
  status = "pending",
  confirmLabel,
  cancelLabel,
  editLabel,
  alwaysLabel,
  disabled,
  destructive,
  leading,
  error,
  note,
  detailsLabel,
  children,
  onConfirm,
  onCancel,
  onEdit,
  onAlways,
}: ConfirmCardProps) {
  return (
    <ConfirmAlert
      title={title}
      description={description}
      status={status}
      confirmLabel={confirmLabel}
      cancelLabel={cancelLabel}
      editLabel={editLabel}
      alwaysLabel={alwaysLabel}
      disabled={disabled}
      destructive={destructive}
      leading={leading}
      error={error}
      note={note}
      detailsLabel={detailsLabel}
      onConfirm={onConfirm}
      onCancel={onCancel}
      onEdit={onEdit}
      onAlways={onAlways}
    >
      {children}
    </ConfirmAlert>
  );
}
