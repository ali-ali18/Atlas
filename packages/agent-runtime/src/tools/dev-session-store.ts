import {
	createDevSession,
	getActiveDevSessionForConversation,
	updateDevSession,
	type DevSessionRecord,
} from "@workspace/db";
import type { DevSessionRow, DevSessionStore } from "./dev-session.js";

function toRow(record: DevSessionRecord): DevSessionRow {
	return {
		id: record.id,
		userId: record.userId,
		conversationId: record.conversationId,
		repo: record.repo,
		branch: record.branch,
		baseBranch: record.baseBranch,
		status: record.status,
		tier: record.tier,
		containerId: record.containerId,
		todos: record.todos,
		preview: record.preview,
		pr: record.pr
			? {
					number: record.pr.number,
					url: record.pr.url,
					state: record.pr.state,
					title: record.pr.title,
					base: record.pr.base,
					head: record.pr.head,
					...(record.pr.headSha ? { headSha: record.pr.headSha } : {}),
				}
			: null,
	};
}

/** Store padrão: tabela `dev_sessions` (Prisma). */
export const prismaDevSessionStore: DevSessionStore = {
	async create(input) {
		return toRow(
			await createDevSession({
				userId: input.userId,
				conversationId: input.conversationId,
				tier: input.tier,
				repo: input.repo,
				branch: input.branch,
				baseBranch: input.baseBranch,
			}),
		);
	},
	async findForConversation(conversationId, userId) {
		const record = await getActiveDevSessionForConversation(conversationId, userId);
		return record ? toRow(record) : null;
	},
	async update(id, patch) {
		const { pr, preview, ...rest } = patch;
		await updateDevSession(id, {
			...rest,
			...(preview === undefined ? {} : { preview }),
			...(pr === undefined
				? {}
				: {
						pr: pr
							? { number: pr.number, url: pr.url, state: pr.state, base: pr.base, head: pr.head, headSha: pr.headSha ?? null, title: pr.title }
							: null,
					}),
		});
	},
};
