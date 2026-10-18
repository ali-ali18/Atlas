import { createNotifier } from "./push.js";
import { prisma } from "./client.js";

/**
 * Eventos que viram notificação push: "o bot precisa do usuário" (cartão de aprovação, questionário,
 * pedido de segredo, login, cartão repassado de outro bot) e "a sessão de código falhou".
 * Quem grava o cartão/estado chama `emitUserNeeded`/`emitCodingFailed`; o processo que tem o remetente
 * (worker e API) registra o ouvinte com `installPushListener`. Sem ouvinte é no-op. Nunca lança.
 */
export type PushEvent =
	| {
			kind: "needs-user";
			conversationId: string;
			/** Id do cartão na conversa (a notificação abre a conversa já nele). */
			cardId: string;
			/** Texto curto do pedido: "Executar · pnpm test", título do questionário... */
			detail: string;
	  }
	| { kind: "coding-failed"; conversationId: string; userId: string; detail: string };

type Listener = (event: PushEvent) => void | Promise<void>;

let listener: Listener | null = null;

export function setPushEventListener(next: Listener | null): void {
	listener = next;
}

function emit(event: PushEvent): void {
	if (!listener) return;
	try {
		void Promise.resolve(listener(event)).catch((error) => console.error("[push] ouvinte falhou", error instanceof Error ? error.message : "erro"));
	} catch (error) {
		console.error("[push] ouvinte falhou", error instanceof Error ? error.message : "erro");
	}
}

export function emitUserNeeded(event: { conversationId: string; cardId: string; detail: string }): void {
	emit({ kind: "needs-user", ...event });
}

export function emitCodingFailed(event: { conversationId: string; userId: string; detail: string }): void {
	emit({ kind: "coding-failed", ...event });
}

/** Liga os eventos acima ao `notify` (resolve o dono da conversa quando o evento não o traz). */
export function installPushListener(notify: ReturnType<typeof createNotifier>): void {
	setPushEventListener(async (event) => {
		const userId =
			event.kind === "coding-failed"
				? event.userId
				: ((await prisma.conversation.findUnique({ where: { id: event.conversationId }, select: { userId: true } })) as { userId: string | null } | null)?.userId;
		if (!userId) return;
		if (event.kind === "coding-failed") await notify(userId, event.conversationId, "coding-failed", event.detail);
		else await notify(userId, event.conversationId, "needs-user", event.detail, { cardId: event.cardId });
	});
}

/** "Executar · pnpm test" / "Editar · src/a.ts" para aprovações de código; senão o título. */
export function approvalDetail(input: { title: string; devApproval?: { kind: string; command?: string; path?: string } | null }): string {
	const dev = input.devApproval;
	if (dev?.kind === "command" && dev.command) return `Executar · ${dev.command}`;
	if (dev?.path) return `Editar · ${dev.path}`;
	return input.title;
}
