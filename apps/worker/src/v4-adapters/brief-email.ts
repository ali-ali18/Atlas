// Fonte de e-mail do plano do dia (F7.2) sobre a porta real de e-mail (F7.1): liga `BriefEmailSource.listRecent`
// (packages/agent/src/ports/brief.ts) a `EmailAccounts`. Só `list` (remetente, assunto, data e o trecho curto que a fonte já
// devolve): o corpo nunca é lido aqui. Sem classificação (`category`): quem classifica é o modelo no `day_plan`.
// O `userId` do run vale para todas as contas; conta de outro dono não aparece (a porta de e-mail já garante).
import type { BriefEmailItem, BriefEmailSource, EmailAccounts, EmailMessageSummary } from "@workspace/agent";
import { createV4Email, type V4EmailDeps, type V4EmailScope } from "./email.js";

const SNIPPET_CHARS = 200;

function toItem(source: string, message: EmailMessageSummary): BriefEmailItem {
	return {
		id: `${source}:${message.id}`,
		from: message.from,
		subject: message.subject,
		receivedAt: message.date,
		...(message.snippet && { snippet: message.snippet.slice(0, SNIPPET_CHARS) }),
	};
}

/** Erro da fonte com o sinal `needs_connection` preservado (login expirado); qualquer outro vira a mensagem real. */
function failureOf(error: unknown): Error {
	const failure = new Error(error instanceof Error ? error.message : "E-mail failed.");
	const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
	if (code === "needs_connection") Object.assign(failure, { code });
	return failure;
}

export function createBriefEmailSource(accounts: Pick<EmailAccounts, "list" | "open">): BriefEmailSource {
	return {
		async listRecent(userId, { since, limit, signal }) {
			const sinceMs = Date.parse(since);
			if (!Number.isFinite(sinceMs) || limit <= 0) return [];
			const infos = await accounts.list(userId);
			// Nenhuma conta ligada: o dono nunca conectou e-mail. Sinal estrutural para o brief ignorar a fonte (e não pedir "reconecte").
			if (infos.length === 0) throw Object.assign(new Error("No e-mail account is connected."), { code: "not_connected" });
			const items: BriefEmailItem[] = [];
			const failures: Error[] = [];
			let read = 0;
			for (const info of infos) {
				try {
					const account = await accounts.open(userId, info.source);
					if (!account) continue;
					const { messages } = await account.list(userId, { since: since.slice(0, 10), limit, primaryOnly: true }, signal);
					read += 1;
					for (const message of messages) {
						if (Date.parse(message.date) >= sinceMs) items.push(toItem(info.source, message));
					}
				} catch (error) {
					if (signal?.aborted) throw error;
					failures.push(failureOf(error));
				}
			}
			// Uma fonte que falha não esconde a outra; se NENHUMA foi lida, a falha vai ao brief (que a conta no cartão).
			if (read === 0 && failures.length > 0) throw failures.find((f) => (f as { code?: unknown }).code === "needs_connection") ?? failures[0]!;
			return items.sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt)).slice(0, limit);
		},
	};
}

/** A fonte do brief de UM run: mesmas contas do `email` (Gmail do dono e caixa do bot do run). */
export function createBriefEmailForRun(input: { scope: Omit<V4EmailScope, "emit">; deps?: V4EmailDeps }): BriefEmailSource {
	return createBriefEmailSource(createV4Email({ scope: { ...input.scope, emit: () => undefined }, ...(input.deps && { deps: input.deps }) }).accounts);
}
