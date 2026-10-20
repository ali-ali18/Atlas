"use client";

import { CheckIcon, KeyRoundIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";
import type { SecretsRequestInfo } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { REQUEST_PRIMARY_CLASS, RequestCard } from "@workspace/ui/components/request-card";
import { saveVaultSecrets } from "@/lib/atlas-api";

type Status = "pending" | "approved" | "rejected" | "failed";

const BADGE = {
	pending: { tone: "pending", label: "Precisa de você" },
	approved: { tone: "success", label: "Salvo no cofre" },
	rejected: { tone: "muted", label: "Pulado" },
	failed: { tone: "danger", label: "Falhou" },
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
export function VaultRequestCard({ info, title, description, status = "pending", confirmLabel = "Salvar no cofre", cancelLabel = "Agora não", onSaved, onSkip, save = (entries) => saveVaultSecrets(entries), initialErrors }: VaultRequestCardProps) {
	const [values, setValues] = useState<Record<string, string>>({});
	const [errors, setErrors] = useState<string[]>(initialErrors ?? []);
	const [busy, setBusy] = useState(false);
	const id = useId();
	const resolved = status !== "pending";

	async function submit() {
		const entries = info.names.flatMap((name) => (values[name] ? [{ name, value: values[name]! }] : []));
		if (entries.length === 0) {
			setErrors(["Preencha ao menos um campo."]);
			return;
		}
		setBusy(true);
		setErrors([]);
		try {
			await save(entries);
			setValues({});
			onSaved?.();
		} catch (cause) {
			setErrors([cause instanceof Error && cause.message ? cause.message : "Não foi possível salvar. Tente novamente."]);
		} finally {
			setBusy(false);
		}
	}

	return (
		<RequestCard
			actions={
				<>
					<Button className={REQUEST_PRIMARY_CLASS} disabled={busy} onClick={() => void submit()} size="sm" type="button">
						{busy ? "Salvando…" : confirmLabel}
					</Button>
					<Button disabled={busy} onClick={onSkip} size="sm" type="button" variant="ghost">
						{cancelLabel}
					</Button>
				</>
			}
			badge={BADGE[status]}
			data-vault-request
			description={description}
			detailsLabel="Ver nomes"
			leading={status === "approved" ? <CheckIcon aria-label="Salvo" /> : status === "rejected" ? <XIcon aria-label="Pulado" /> : <KeyRoundIcon aria-label="Cofre" />}
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
								placeholder="Cole aqui"
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
						<p className="m-0 text-muted-foreground text-xs">Vai direto para o seu cofre, criptografado. O bot usa o segredo sem nunca ler o valor.</p>
					)}
				</form>
			)}
		</RequestCard>
	);
}
