// Porta `Skills` do v4 no worker (F9): as habilidades do dono (tabela `skillDoc` via `@workspace/db`). Montado POR RUN: o bot,
// a conversa e o `emit` vêm do run, nunca de argumento do modelo; toda função do db recebe o `userId` do RUN e filtra por ele
// na query (40-seguranca), então habilidade de outro dono é indistinguível de inexistente. O run só enxerga as da CONTA e as
// do SEU bot: a de outro bot do mesmo dono não aparece, não se lê, não se edita e não se apaga por aqui. NÃO importa o
// agent-runtime: validação, limites e gravação já moram em `@workspace/db` e `@workspace/shared`.
//
// Escrita grava e mostra o cartão `skill` ("Aprendi", com Desfazer, o mesmo do motor antigo: `undoLearnedSkill` na API).
import type { SkillDoc, SkillSaveInput, Skills } from "@workspace/agent";
import { SkillDocError, applySkillProposal, deleteSkillDoc, listSkillDocs, persistConversationCardFromEvent, readSkillDocByName, type SkillDocRecord } from "@workspace/db";
import type { ComputerUseEvent } from "@workspace/shared";

export type V4SkillsDeps = {
	list: typeof listSkillDocs;
	read: typeof readSkillDocByName;
	apply: typeof applySkillProposal;
	remove: typeof deleteSkillDoc;
	persistCard: (conversationId: string, event: ComputerUseEvent) => Promise<void>;
};

export const realV4SkillsDeps: V4SkillsDeps = {
	list: listSkillDocs,
	read: readSkillDocByName,
	apply: applySkillProposal,
	remove: deleteSkillDoc,
	persistCard: (conversationId, event) => persistConversationCardFromEvent(conversationId, event),
};

export type V4SkillsScope = {
	/** O bot do run. Sem bot só existem habilidades da conta. */
	botId?: string | null;
	conversationId?: string | null;
	emit: (event: ComputerUseEvent) => void | Promise<void>;
	log?: (message: string) => void;
};

export function toSkillDoc(doc: SkillDocRecord): SkillDoc {
	return {
		id: doc.id,
		name: doc.name,
		description: doc.description,
		tools: doc.tools,
		scope: doc.botId ? "bot" : "account",
		enabled: doc.enabled,
		status: doc.status,
		revision: doc.revision,
		body: doc.body,
	};
}

/** Nomes das habilidades ATIVAS do run (conta + bot; a do bot vence na colisão), ordenados: o índice curto do prompt. Falha de leitura não derruba o run. */
export async function loadV4SkillNames(input: { userId: string; botId?: string | null; deps?: Pick<V4SkillsDeps, "list">; log?: (message: string) => void }): Promise<string[]> {
	try {
		const docs = await (input.deps?.list ?? listSkillDocs)(input.userId);
		const names = docs.filter((doc) => doc.enabled && doc.status === "active" && (doc.botId === null || doc.botId === (input.botId ?? null))).map((doc) => doc.name);
		return [...new Set(names)].sort();
	} catch (error) {
		(input.log ?? console.warn)(`[engine-v4] índice de habilidades não carregado: ${(error instanceof Error ? error.message : "erro").slice(0, 200)}`);
		return [];
	}
}

export function createV4Skills(input: { scope: V4SkillsScope; deps?: V4SkillsDeps }): Skills {
	const deps = input.deps ?? realV4SkillsDeps;
	const { scope } = input;
	const botId = scope.botId?.trim() || null;
	const log = scope.log ?? console.warn;

	/** Visível neste run: da conta ou do bot do run. */
	const visible = (doc: SkillDocRecord) => doc.botId === null || doc.botId === botId;

	async function showCard(event: ComputerUseEvent): Promise<void> {
		if (scope.conversationId) {
			await deps.persistCard(scope.conversationId, event).catch((error: unknown) => {
				log(`[engine-v4] cartão "skill" não gravado na conversa: ${(error instanceof Error ? error.message : "erro").slice(0, 200)}`);
			});
		}
		await scope.emit(event);
	}

	return {
		async list(userId) {
			return (await deps.list(userId)).filter(visible).map(toSkillDoc);
		},
		async read(userId, name) {
			// Bot antes da conta; só ativa e ligada (o db filtra). Nunca procura em outro bot.
			const found = (botId ? await deps.read(userId, name, botId) : null) ?? (await deps.read(userId, name, null));
			return found && visible(found) ? toSkillDoc(found) : null;
		},
		async save(userId, _runId, save: SkillSaveInput) {
			if (save.scope === "bot" && !botId) throw new Error('This run has no bot: use scope "account".');
			const targetBot = save.scope === "bot" ? botId : null;
			if (save.action === "edit") {
				// O alvo precisa ser visível neste run (conta ou este bot): o id vem da tool, mas a conferência é daqui.
				const target = (await deps.list(userId)).find((doc) => doc.id === save.skillId);
				if (!target || !visible(target)) throw new Error("Skill não encontrada.");
			}
			let applied: Awaited<ReturnType<V4SkillsDeps["apply"]>>;
			try {
				applied = await deps.apply(userId, {
					action: save.action,
					name: save.name,
					description: save.description,
					tools: save.tools,
					body: save.body,
					botId: targetBot,
					skillId: save.skillId,
					expectedRevision: save.expectedRevision,
				});
			} catch (error) {
				if (error instanceof SkillDocError) throw new Error(`Could not save the skill: ${error.message}`);
				throw error;
			}
			if (!applied.skillId || !applied.revision) throw new Error("Could not save the skill: no id returned.");
			await showCard({
				type: "skill",
				action: save.action === "create" ? "created" : "updated",
				title: save.name,
				capabilityKey: save.name,
				versionNumber: applied.revision,
				detail: save.description,
				skillId: applied.skillId,
				learned: true,
			});
			return { skillId: applied.skillId, revision: applied.revision };
		},
		async remove(userId, _runId, skillId) {
			const target = (await deps.list(userId)).find((doc) => doc.id === skillId);
			if (!target || !visible(target)) return false;
			if (!(await deps.remove(userId, skillId))) return false;
			await showCard({ type: "skill", action: "deleted", title: target.name, capabilityKey: target.name });
			return true;
		},
	};
}
