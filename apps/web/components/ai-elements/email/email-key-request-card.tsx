"use client";

import { CheckIcon, MailIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { REQUEST_PRIMARY_CLASS, RequestCard } from "@workspace/ui/components/request-card";
import { openSettingsModal } from "@/components/settings/settings-url";
import { saveEmailAccountKey } from "@/lib/atlas-api";

type Status = "pending" | "approved" | "rejected" | "failed";

const BADGE = {
	pending: { tone: "pending", label: "Precisa de você" },
	approved: { tone: "success", label: "Chave salva" },
	rejected: { tone: "muted", label: "Pulado" },
	failed: { tone: "danger", label: "Falhou" },
} as const;

export type EmailKeyRequestCardProps = {
	title: string;
	description?: string;
	status?: Status;
	/** Depois de salvar: retoma o agente (só avisa que salvou; a chave nunca vai junto). */
	onSaved?: () => void;
	onSkip?: () => void;
	/** Injetável em testes e na pré-visualização. */
	save?: (apiKey: string) => Promise<unknown>;
	initialError?: string;
};

/**
 * Pedido da chave do OpenMail: um campo de senha que envia a chave direto do navegador à API
 * (que a guarda cifrada). O texto da conversa, o modelo, os eventos e o histórico nunca a contêm;
 * depois de salvar o cartão só mostra "Chave salva".
 */
export function EmailKeyRequestCard({ title, description, status = "pending", onSaved, onSkip, save = (apiKey) => saveEmailAccountKey(apiKey), initialError }: EmailKeyRequestCardProps) {
	const [value, setValue] = useState("");
	const [error, setError] = useState<string | null>(initialError ?? null);
	const [busy, setBusy] = useState(false);
	const id = useId();
	const resolved = status !== "pending";

	async function submit() {
		const key = value.trim();
		if (!key) {
			setError("Cole a chave do OpenMail.");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await save(key);
			setValue("");
			onSaved?.();
		} catch (cause) {
			setError(cause instanceof Error && cause.message ? cause.message : "Não foi possível salvar a chave. Tente novamente.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<RequestCard
			actions={
				<>
					<Button className={REQUEST_PRIMARY_CLASS} disabled={busy || !value.trim()} onClick={() => void submit()} size="sm" type="button">
						{busy ? "Salvando…" : "Salvar chave"}
					</Button>
					<Button disabled={busy} onClick={() => openSettingsModal("provedores")} size="sm" type="button" variant="outline">
						Abrir Configurações
					</Button>
				</>
			}
			badge={BADGE[status]}
			data-email-key-request
			description={description}
			leading={status === "approved" ? <CheckIcon aria-label="Chave salva" /> : status === "rejected" ? <XIcon aria-label="Pulado" /> : <MailIcon aria-label="E-mail" />}
			resolved={resolved}
			title={title}
			trailing={
				<Button disabled={busy} onClick={onSkip} size="sm" type="button" variant="ghost">
					Agora não
				</Button>
			}
		>
			{resolved ? (
				<p className="m-0 text-muted-foreground text-xs">{status === "approved" ? "Chave salva. O bot já pode criar o e-mail." : "Sem a chave o bot não pode ter e-mail."}</p>
			) : (
				<form
					className="flex min-w-0 flex-col gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						void submit();
					}}
				>
					<label className="text-muted-foreground text-xs" htmlFor={`${id}-key`}>
						Chave da API do OpenMail
					</label>
					<Input
						aria-invalid={error ? true : undefined}
						autoComplete="new-password"
						autoCorrect="off"
						id={`${id}-key`}
						name="openmail-key"
						onChange={(event) => {
							setValue(event.target.value);
							setError(null);
						}}
						placeholder="Cole aqui"
						spellCheck={false}
						type="password"
						value={value}
					/>
					{error ? (
						<p className="m-0 text-destructive text-xs" role="alert">
							{error}
						</p>
					) : (
						<p className="m-0 text-muted-foreground text-xs">Vai direto do campo para o servidor, criptografada. O bot nunca vê a chave.</p>
					)}
				</form>
			)}
		</RequestCard>
	);
}
