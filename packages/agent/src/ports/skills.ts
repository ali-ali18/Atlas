// Porta `Skills` (F9): as habilidades do dono (procedimentos em Markdown). O bot do run vem preso no adaptador (um por
// run); toda chamada leva o `userId` do RUN (nunca do modelo) e o adaptador só enxerga habilidades desse dono: da conta
// (`scope: "account"`) e deste bot (`scope: "bot"`). Habilidade de outro dono, ou de outro bot, é indistinguível de
// inexistente. Falha real = `throw` com a mensagem (a tool devolve `ok:false`). Escrita mostra o cartão `skill` no chat
// (o adaptador emite).

export type SkillScope = "account" | "bot";

export type SkillView = {
	id: string;
	name: string;
	/** Quando usar, uma linha. */
	description: string;
	/** Dica de ferramentas úteis (nunca uma permissão). */
	tools: string[];
	scope: SkillScope;
	enabled: boolean;
	status: "active" | "draft";
	revision: number;
};

export type SkillDoc = SkillView & { body: string };

export type SkillSaveInput = {
	action: "create" | "edit";
	name: string;
	description: string;
	tools: string[];
	body: string;
	scope: SkillScope;
	/** Só em `edit`: a habilidade alvo e a revisão lida (a gravação falha se mudou no meio). */
	skillId?: string;
	expectedRevision?: number;
};

export interface Skills {
	/** Todas as habilidades visíveis neste run (conta + este bot; ativas, rascunhos e desligadas), por nome. */
	list(userId: string): Promise<SkillDoc[]>;
	/** Uma habilidade ATIVA e ligada pelo nome; a do bot vence a da conta. `null` = não existe, está desligada ou é de outro dono. */
	read(userId: string, name: string): Promise<SkillDoc | null>;
	/** Cria ou edita e mostra o cartão "Aprendi" (com desfazer). Lança com o motivo (nome repetido, limite, revisão velha). */
	save(userId: string, runId: string, input: SkillSaveInput): Promise<{ skillId: string; revision: number }>;
	/** Apaga de vez e mostra o cartão. `false` = não existe (ou é de outro dono). */
	remove(userId: string, runId: string, skillId: string): Promise<boolean>;
}
