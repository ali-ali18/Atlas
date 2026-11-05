// Bolinha de status no canto do avatar do bot (home). Mesma precedência e medidas do web
// (`apps/web/.../template-4/avatar-status.tsx`): trabalhando > precisa de você > não lida. O web ainda não tem o
// estado "precisa de você" no avatar; aqui ele é amarelo (token de estado `warning`, o mesmo do selo dos cards).
// Funções puras, testadas em avatar-status.test.ts.

export type AvatarStatusKind = "working" | "needs" | "unread" | "none";

export function resolveAvatarStatus({ working, needsYou, unread }: { working?: boolean; needsYou?: boolean; unread?: boolean }): AvatarStatusKind {
	if (working) return "working";
	if (needsYou) return "needs";
	if (unread) return "unread";
	return "none";
}

export const AVATAR_STATUS_LABELS: Record<Exclude<AvatarStatusKind, "none">, string> = {
	working: "Trabalhando",
	needs: "Precisa de você",
	unread: "Não lida",
};

/** Bolinha proporcional ao avatar: 26%, entre 10 e 16 (mesma conta do web, `avatarDotMetrics`). */
export function avatarDotSize(body: number): number {
	return Math.min(16, Math.max(10, Math.round(body * 0.26)));
}

/** Papéis de card que esperam uma ação do usuário (como `BOT_NEED_CARD_ROLES` do shared). */
const NEEDS_ROLES: ReadonlySet<string> = new Set(["login", "confirm", "bot-profile", "questionnaire", "skill-proposal"]);

/**
 * A última mensagem é um card que ainda espera o usuário (login, aprovação, questionário, perfil, habilidade)?
 * O servidor corta o `content` da prévia em 200 caracteres, então o `status` do JSON nem sempre chega: só vale
 * quando o campo está legível e é `pending`. Campo cortado = não sabemos = não acende (nunca inventa).
 */
export function lastMessageNeedsYou(last: { role: string; content: string } | null | undefined): boolean {
	if (!last || !NEEDS_ROLES.has(last.role)) return false;
	const match = /"status"\s*:\s*"([a-z]+)"/.exec(last.content);
	return match?.[1] === "pending";
}
