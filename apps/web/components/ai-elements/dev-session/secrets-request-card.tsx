"use client";

import { CheckIcon, KeyRoundIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";
import { secretsRequestTemplate, type SecretsRequestInfo } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { REQUEST_PRIMARY_CLASS, RequestCard } from "@workspace/ui/components/request-card";
import { Textarea } from "@workspace/ui/components/textarea";
import { analyzeSecretsText } from "@/components/settings/dev-environments-state";
import { setDevEnvironmentSecrets } from "@/lib/atlas-api";

type Status = "pending" | "approved" | "rejected" | "failed";

const BADGE = {
	pending: { tone: "pending", label: "Precisa de você" },
	approved: { tone: "success", label: "Salvo" },
	rejected: { tone: "muted", label: "Dispensado" },
	failed: { tone: "danger", label: "Falhou" },
} as const;

export type SecretsRequestCardProps = {
	info: SecretsRequestInfo;
	title: string;
	/** Motivo dado pelo agente. */
	description?: string;
	status?: Status;
	confirmLabel?: string;
	cancelLabel?: string;
	/** Chamado depois de salvar: retoma o agente (só com os nomes, nunca os valores). */
	onSaved?: () => void;
	onSkip?: () => void;
	/** Injetável em testes e na pré-visualização; padrão = API de segredos em lote. */
	save?: (environmentId: string, entries: { name: string; value: string }[]) => Promise<unknown>;
	/** Texto inicial do campo (testes/pré-visualização). */
	initialText?: string;
	initialErrors?: string[];
};

/**
 * Pedido de segredos do agente: textarea com `NOME=` por linha. Os valores vão
 * daqui direto para a API criptografada; o agente só recebe os nomes salvos.
 */
export function SecretsRequestCard({ info, title, description, status = "pending", confirmLabel = "Salvar", cancelLabel = "Agora não", onSaved, onSkip, save = setDevEnvironmentSecrets, initialText, initialErrors }: SecretsRequestCardProps) {
	const [text, setText] = useState(initialText ?? secretsRequestTemplate(info.names));
	const [errors, setErrors] = useState<string[]>(initialErrors ?? []);
	const [busy, setBusy] = useState(false);
	const [savedNames, setSavedNames] = useState<string[]>([]);
	const id = useId();
	const resolved = status !== "pending";

	async function submit() {
		const analysis = analyzeSecretsText(text, []);
		if (analysis.errors.length > 0) {
			setErrors(analysis.errors);
			return;
		}
		if (analysis.entries.length === 0) {
			setErrors(["Preencha ao menos um valor (NOME=valor)."]);
			return;
		}
		setBusy(true);
		setErrors([]);
		setSavedNames([]);
		try {
			await save(info.environmentId, analysis.entries);
			setText("");
			setSavedNames(analysis.entries.map((entry) => entry.name));
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
			data-secrets-request
			description={description}
			detailsLabel="Ver nomes"
			leading={status === "approved" ? <CheckIcon aria-label="Salvo" /> : status === "rejected" ? <XIcon aria-label="Dispensado" /> : <KeyRoundIcon aria-label="Segredos" />}
			resolved={resolved}
			title={title}
		>
			{resolved ? (
				<p className="m-0 font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{info.names.join(", ")}</p>
			) : (
				<div className="flex min-w-0 flex-col gap-2">
					<Textarea
						aria-invalid={errors.length > 0 ? true : undefined}
						aria-label="Segredos (NOME=valor, um por linha)"
						autoComplete="off"
						className="min-h-[5.5rem] font-mono text-body leading-5"
						id={id}
						onChange={(event) => {
							setText(event.target.value);
							setErrors([]);
						}}
						rows={Math.min(8, Math.max(3, info.names.length + 1))}
						spellCheck={false}
						value={text}
					/>
					{errors.length > 0 ? (
						<div className="flex flex-col gap-0.5" data-secrets-request-errors>
							{errors.map((message) => (
								<p className="m-0 text-xs text-destructive" key={message} role="alert">
									{message}
								</p>
							))}
						</div>
					) : savedNames.length > 0 ? (
						<p className="m-0 text-muted-foreground text-xs" data-secrets-request-saved role="status">
							Salvo: {savedNames.join(", ")}
						</p>
					) : (
						<p className="m-0 text-muted-foreground text-xs">Criptografados; o agente só vê os nomes salvos, nunca os valores. Apague as linhas que não quiser preencher.</p>
					)}
				</div>
			)}
		</RequestCard>
	);
}
