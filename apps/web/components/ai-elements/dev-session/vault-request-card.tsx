"use client";

import { CheckIcon, KeyRoundIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";
import type { SecretsRequestInfo } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { REQUEST_PRIMARY_CLASS, RequestCard } from "@workspace/ui/components/request-card";
import { saveVaultLogin, saveVaultSecrets } from "@/lib/atlas-api";
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
	/** Pedido de login (`info.login`): grava os campos num item de login do site. Injetável em testes. */
	saveLogin?: (input: { site: string; name?: string; fields: { key: string; label: string; secret: boolean; value: string }[] }) => Promise<unknown>;
	initialErrors?: string[];
};

/**
 * Pedido do bot para o Cofre. Segredo simples: um campo de senha por nome. Login (`info.login`): um campo por item que a IA
 * declarou (rótulo legível; de senha quando é secreto, de texto quando não é), todos obrigatórios. O valor vai direto do campo
 * para a API do cofre; o texto da conversa, o evento e o log nunca o contêm.
 */
export function VaultRequestCard({ info, title, description, status = "pending", confirmLabel, cancelLabel, onSaved, onSkip, save = (entries) => saveVaultSecrets(entries), saveLogin = (input) => saveVaultLogin(input), initialErrors }: VaultRequestCardProps) {
	const { t } = useTranslations();
	const [values, setValues] = useState<Record<string, string>>({});
	const [errors, setErrors] = useState<string[]>(initialErrors ?? []);
	const [busy, setBusy] = useState(false);
	const id = useId();
	const resolved = status !== "pending";

	async function submit() {
		if (info.login) {
			const login = info.login;
			if (login.fields.some((field) => !values[field.key])) {
				setErrors([t("devSession.vault.fillAll")]);
				return;
			}
			setBusy(true);
			setErrors([]);
			try {
				await saveLogin({ site: login.site, ...(login.name && { name: login.name }), fields: login.fields.map((field) => ({ ...field, value: values[field.key]! })) });
				setValues({});
				onSaved?.();
			} catch (cause) {
				setErrors([cause instanceof Error && cause.message ? cause.message : t("devSession.secrets.saveError")]);
			} finally {
				setBusy(false);
			}
			return;
		}
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

	// Login: um campo por item declarado (rótulo na tela, chave só como nome do campo); segredo simples: um por nome.
	const inputs = info.login ? info.login.fields.map((field) => ({ key: field.key, label: field.label, secret: field.secret })) : info.names.map((name) => ({ key: name, label: name, secret: true }));

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
				<p className={info.login ? "m-0 text-xs text-muted-foreground [overflow-wrap:anywhere]" : "m-0 font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]"}>{info.login ? info.login.fields.map((field) => field.label).join(", ") : info.names.join(", ")}</p>
			) : (
				<form
					className="flex min-w-0 flex-col gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						void submit();
					}}
				>
					{inputs.map(({ key, label, secret }) => (
						<div className="flex min-w-0 flex-col gap-1" key={key}>
							<label className={info.login ? "text-xs text-muted-foreground" : "font-mono text-xs text-muted-foreground"} htmlFor={`${id}-${key}`}>
								{label}
							</label>
							<Input
								aria-invalid={errors.length > 0 ? true : undefined}
								autoComplete={secret ? "new-password" : "off"}
								autoCorrect="off"
								id={`${id}-${key}`}
								name={key}
								onChange={(event) => {
									setValues((current) => ({ ...current, [key]: event.target.value }));
									setErrors([]);
								}}
								placeholder={secret ? t("devSession.vault.paste") : t("devSession.vault.type")}
								spellCheck={false}
								type={secret ? "password" : "text"}
								value={values[key] ?? ""}
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
						<p className="m-0 text-muted-foreground text-xs">{t(info.login ? "devSession.vault.loginNote" : "devSession.vault.note")}</p>
					)}
				</form>
			)}
		</RequestCard>
	);
}
