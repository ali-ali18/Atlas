// Porta `Memory`: memória durável do dono (F2.4). Duas camadas, como no produto:
//  - `owner`: perfil e preferências estáveis do dono, valem para todos os bots dele (nome, idioma, fuso, profissão, jeito de falar);
//  - `bot`: o que é DESTE bot (projetos, decisões, contexto de trabalho).
// Toda chamada leva o `userId` do run e o adaptador filtra por dono; o bot da camada `bot` vem preso no adaptador
// (o worker monta um por run), nunca de argumento do modelo. O adaptador guarda o histórico da mudança (desfazer).

export const MEMORY_LAYERS = ["owner", "bot"] as const;
export type MemoryLayer = (typeof MEMORY_LAYERS)[number];

export type MemoryItem = { id: string; layer: MemoryLayer; content: string; category?: string; updatedAt: Date };

export type MemoryAddInput = { layer: MemoryLayer; content: string; category?: string };

export interface Memory {
	/** Entradas do dono, da mais antiga à mais nova. Sem `layer`, as duas camadas. */
	list(userId: string, layer?: MemoryLayer): Promise<MemoryItem[]>;
	add(userId: string, input: MemoryAddInput): Promise<MemoryItem>;
	/** `null` = não existe para este dono (inclui entrada de outro dono). */
	replace(userId: string, id: string, content: string): Promise<MemoryItem | null>;
	/** `false` = não existe para este dono. */
	remove(userId: string, id: string): Promise<boolean>;
}
