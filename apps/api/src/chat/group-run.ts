import { isCardConfirmToken } from "@workspace/shared";
import { getGroupWithMembers, getSkillPendingIntent } from "@workspace/db";

export type GroupRunTarget =
	| { kind: "pass" }
	| { kind: "member"; botId: string; conversationId: string }
	| { kind: "reject"; status: 400; error: string };

/**
 * `POST /v1/runs` com `botId` de um grupo. Conversa normal vai por
 * `POST /v1/groups/:id/messages` (o worker escolhe quem responde). Só o clique de um
 * card de confirmação passa por aqui: a decisão é do membro dono do pedido pendente,
 * então o run sai com o `botId` dele, na conversa do grupo.
 */
export async function resolveGroupRunTarget(
	request: { botId?: string; messages: ReadonlyArray<{ role: string; content: string }> },
	userId: string,
	deps: { group?: typeof getGroupWithMembers; pending?: typeof getSkillPendingIntent } = {},
): Promise<GroupRunTarget> {
	if (!request.botId) return { kind: "pass" };
	const found = await (deps.group ?? getGroupWithMembers)(userId, request.botId);
	if (!found) return { kind: "pass" };
	const conversationId = found.group.conversationId;
	const text = [...request.messages].reverse().find((message) => message.role === "user")?.content.trim() ?? "";
	const isCardClick = isCardConfirmToken(text) || /^cancela isso$/i.test(text);
	if (!conversationId || !isCardClick) {
		return { kind: "reject", status: 400, error: "Em grupo, envie a mensagem por /v1/groups/:id/messages." };
	}
	const pending = await (deps.pending ?? getSkillPendingIntent)(userId, conversationId);
	const owner = pending?.payload.botId;
	if (!owner || !found.members.some((member) => member.id === owner)) {
		return { kind: "reject", status: 400, error: "Não há nada pendente para confirmar neste grupo." };
	}
	return { kind: "member", botId: owner, conversationId };
}
