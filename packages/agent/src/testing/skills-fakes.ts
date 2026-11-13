// Fake da porta `Skills` para teste: habilidades POR DONO (outro dono não lê, não edita e não apaga) e por bot (a do outro bot
// não aparece), com a mesma semântica do adaptador do worker, mais o registro dos cartões mostrados.
import type { SkillDoc, SkillSaveInput, Skills } from "../ports/skills.js";

export type FakeSkillRow = SkillDoc & { owner: string; botId: string | null };

export class FakeSkills implements Skills {
	readonly cards: Array<{ userId: string; runId: string; kind: "saved" | "deleted"; name: string }> = [];
	private seq = 0;

	constructor(
		readonly rows: FakeSkillRow[] = [],
		/** O bot do run (preso no adaptador). */
		readonly selfBotId: string | null = "bot-a",
	) {}

	row(owner: string, name: string, over: Partial<FakeSkillRow> = {}): FakeSkillRow {
		const row: FakeSkillRow = { id: `skill-${++this.seq}`, name, description: `Usar ${name}`, tools: [], scope: "account", enabled: true, status: "active", revision: 1, body: "1. Faça isto.", owner, botId: null, ...over };
		this.rows.push(row);
		return row;
	}

	private visible(userId: string): FakeSkillRow[] {
		return this.rows.filter((r) => r.owner === userId && (r.botId === null || r.botId === this.selfBotId));
	}
	private view({ owner: _owner, botId: _botId, ...doc }: FakeSkillRow): SkillDoc {
		return { ...doc };
	}

	async list(userId: string): Promise<SkillDoc[]> {
		return this.visible(userId).map((r) => this.view(r)).sort((a, b) => (a.name < b.name ? -1 : 1));
	}
	async read(userId: string, name: string): Promise<SkillDoc | null> {
		const active = this.visible(userId).filter((r) => r.name === name && r.enabled && r.status === "active");
		const hit = active.find((r) => r.botId !== null) ?? active.find((r) => r.botId === null);
		return hit ? this.view(hit) : null;
	}
	async save(userId: string, runId: string, input: SkillSaveInput): Promise<{ skillId: string; revision: number }> {
		if (input.action === "create") {
			const botId = input.scope === "bot" ? this.selfBotId : null;
			if (input.scope === "bot" && !botId) throw new Error("this run has no bot");
			const row = this.row(userId, input.name, { description: input.description, tools: input.tools, body: input.body, scope: input.scope, botId });
			this.cards.push({ userId, runId, kind: "saved", name: input.name });
			return { skillId: row.id, revision: row.revision };
		}
		const row = this.rows.find((r) => r.owner === userId && r.id === input.skillId);
		if (!row) throw new Error("Skill não encontrada.");
		if (row.revision !== input.expectedRevision) throw new Error("A skill mudou desde que foi lida.");
		Object.assign(row, { description: input.description, tools: input.tools, body: input.body, revision: row.revision + 1 });
		this.cards.push({ userId, runId, kind: "saved", name: input.name });
		return { skillId: row.id, revision: row.revision };
	}
	async remove(userId: string, runId: string, skillId: string): Promise<boolean> {
		const index = this.rows.findIndex((r) => r.owner === userId && r.id === skillId);
		if (index < 0) return false;
		const [gone] = this.rows.splice(index, 1);
		this.cards.push({ userId, runId, kind: "deleted", name: gone!.name });
		return true;
	}
}
