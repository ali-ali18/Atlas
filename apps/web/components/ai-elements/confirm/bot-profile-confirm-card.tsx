"use client";

import { UserCogIcon } from "lucide-react";
import type { ConfirmStatus } from "@workspace/ui/components/confirm-alert";
import { useTranslations } from "@/lib/i18n/provider";
import { ConfirmCard } from "./confirm-card";
import {
  getProposalRows,
  getProposalTitle,
  type BotProfileProposal,
} from "./bot-profile-proposal";

export type BotProfileConfirmCardProps = {
  proposal: BotProfileProposal;
  status?: ConfirmStatus;
  /** true durante o PATCH — trava os botões (evita duplo confirm). */
  isApplying?: boolean;
  error?: string | null;
  confirmLabel?: string;
  cancelLabel?: string;
  editLabel?: string;
  onConfirm?: () => void;
  /** Dispensar = descartar sem PATCH. */
  onDismiss?: () => void;
  /** Editar = voltar ao campo (mantém proposta pendente). */
  onEdit?: () => void;
};

function DiffValue({ value, tone }: { value: string; tone: "before" | "after" }) {
  return (
    <span
      className={
        tone === "before"
          ? "block truncate text-sm text-muted-foreground line-through decoration-muted-foreground/50"
          : "block break-words font-medium text-[15px] text-foreground"
      }
      title={value}
    >
      {value}
    </span>
  );
}

export function BotProfileConfirmCard({
  proposal,
  status = "pending",
  isApplying = false,
  error,
  confirmLabel,
  cancelLabel,
  editLabel,
  onConfirm,
  onDismiss,
  onEdit,
}: BotProfileConfirmCardProps) {
  const translator = useTranslations();
  const { t } = translator;
  const rows = getProposalRows(proposal, translator);
  // Sem descrição interna: a explicação vai na mensagem do chat (texto final
  // do run); o card mostra só título + antes/depois + ações.
  return (
    <ConfirmCard
      title={getProposalTitle(proposal, translator)}
      status={status}
      confirmLabel={isApplying ? t("aiElements.profile.applying") : (confirmLabel ?? t("aiElements.profile.apply"))}
      cancelLabel={cancelLabel ?? t("aiElements.profile.dismiss")}
      editLabel={editLabel ?? t("aiElements.profile.edit")}
      disabled={isApplying}
      leading={<UserCogIcon aria-hidden />}
      error={error}
      detailsLabel={t("aiElements.profile.viewChanges")}
      onConfirm={onConfirm}
      onCancel={onDismiss}
      onEdit={onEdit}
    >
      <div className="divide-y divide-border/60 overflow-hidden rounded-xl bg-background/70 ring-1 ring-foreground/5">
        {rows.map((row) => (
          <div key={row.field} className="flex min-w-0 flex-col gap-1 px-4 py-3">
            <p className="text-xs font-medium text-muted-foreground">
              {row.label}
            </p>
            <DiffValue value={row.before} tone="before" />
            <DiffValue value={row.after} tone="after" />
          </div>
        ))}
      </div>
    </ConfirmCard>
  );
}
