"use client";

import { CheckIcon, KeyRoundIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";
import type { SecretsRequestInfo } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { REQUEST_PRIMARY_CLASS, RequestCard } from "@workspace/ui/components/request-card";
import { saveVaultSecrets } from "@/lib/atlas-api";
import { useTranslations } from "@/lib/i18n/provider";

type Status = "pending" | "approved" | "rejected" | "failed";

const BADGE = {
	pending: { tone: "pending", label: "devSession.approval.pending" },
	approved: { tone: "success", label: "devSession.secrets.savedToVault" },
	rejected: { tone: "muted", label: "devSession.secrets.dismissed" },
	failed: { tone: "danger", label: "devSession.approval.failed" },
} as const;

export type VaultRequestCardProps = {
	info: SecretsRequestInfo;
	title: string;
	/** Motivo dado pelo agente. */
	description?: string;
	status?: Status;
	confirmLabel?: string;
	cancelLabel?: string;
	/** Depois de salvar: retoma o agente com os nomes (nunca os valores). */
	onSaved?: () => void;
	onSkip?: () => void;
	/** Injetável em testes e na pré-visualização. */
	save?: (entries: { name: string; value: string }[]) => Promise<unknown>;
	initialErrors?: string[];
};

/**
 * Pedido de segredo do bot para o Cofre: um campo de senha por nome. O valor vai direto
 * do campo para a API do cofre; o texto da conversa nunca o contém.
 */
export function VaultRequestCard({ info, title, description, status = "pending", confirmLabel, cancelLabel, onSaved, onSkip, save = (entries) => saveVaultSecrets(entries), initialErrors }: VaultRequestCardProps) {
	const { t } = useTranslations();
	const [values, setValues] = useState<Record<string, string>>({});
	const [errors, setErrors] = useState<string[]>(initialErrors ?? []);
	const [busy, setBusy] = useState(false);
	const id = useId();
	const resolved = status !== "pending";

	async function submit() {
		const entries = info.names.flatMap((name) => (values[name] ? [{ name, value: values[name]! }] : []));
		if (entries.length === 0) {
			setErrors([t("devSession.vault.fillOne")]);
			return;
		}
		setBusy(true);
		setErrors([]);
		try {
			await save(entries);
			setValues({});
			onSaved?.();
		} catch (cause) {
			setErrors([cause instanceof Error && cause.message ? cause.message : t("devSession.secrets.saveError")]);
		} finally {
			setBusy(false);
		}
	}

	return (
		<RequestCard
			actions={
				<>
					<Button className={REQUEST_PRIMARY_CLASS} disabled={busy} onClick={() => void submit()} size="sm" type="button">
						{busy ? t("devSession.secrets.saving") : (confirmLabel ?? t("devSession.vault.saveToVault"))}
					</Button>
					<Button disabled={busy} onClick={onSkip} size="sm" type="button" variant="ghost">
						{cancelLabel ?? t("devSession.approval.notNow")}
					</Button>
				</>
			}
			badge={{ tone: BADGE[status].tone, label: t(BADGE[status].label) }}
			data-vault-request
			description={description}
			detailsLabel={t("devSession.secrets.viewNames")}
			leading={status === "approved" ? <CheckIcon aria-label={t("devSession.secrets.saved")} /> : status === "rejected" ? <XIcon aria-label={t("devSession.secrets.dismissed")} /> : <KeyRoundIcon aria-label={t("devSession.vault.vaultLabel")} />}
			resolved={resolved}
			title={title}
		>
			{resolved ? (
				<p className="m-0 font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{info.names.join(", ")}</p>
			) : (
				<form
					className="flex min-w-0 flex-col gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						void submit();
					}}
				>
					{info.names.map((name) => (
						<div className="flex min-w-0 flex-col gap-1" key={name}>
							<label className="font-mono text-xs text-muted-foreground" htmlFor={`${id}-${name}`}>
								{name}
							</label>
							<Input
								aria-invalid={errors.length > 0 ? true : undefined}
								autoComplete="new-password"
								autoCorrect="off"
								id={`${id}-${name}`}
								name={name}
								onChange={(event) => {
									setValues((current) => ({ ...current, [name]: event.target.value }));
									setErrors([]);
								}}
								placeholder={t("devSession.vault.paste")}
								spellCheck={false}
								type="password"
								value={values[name] ?? ""}
							/>
						</div>
					))}
					{errors.length > 0 ? (
						<div className="flex flex-col gap-0.5" data-vault-request-errors>
							{errors.map((message) => (
								<p className="m-0 text-xs text-destructive" key={message} role="alert">
									{message}
								</p>
							))}
						</div>
					) : (
						<p className="m-0 text-muted-foreground text-xs">{t("devSession.vault.note")}</p>
					)}
				</form>
			)}
		</RequestCard>
	);
}
