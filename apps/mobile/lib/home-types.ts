// O que a home desenha, e só isso. É também o que vai para o cache do aparelho: nada de `policyJson`, descrição,
// modelo nem o texto inteiro da última mensagem (o cache fica sem criptografia no armazenamento do app).

import type { CardIconKey } from "./card-preview";

export type HomeBot = {
	id: string;
	name: string;
	color: string;
	shape: string;
	pinned: boolean;
	pinOrder: number | null;
	sectionId: string | null;
	memberIds: string[];
	isPrimary: boolean;
	/** Conversa do bot (o fio do chat); `null` até a primeira mensagem. */
	conversationId: string | null;
	/** Idioma do bot ("auto" ou um idioma); `null` em cache antigo. */
	language: string | null;
	/** Há mensagem nova ou o usuário marcou como não lida. */
	unread: boolean;
	/** ISO da última mensagem (a data da linha). */
	lastAt: string | null;
	/** Prévia da última mensagem, já limpa e truncada (`PREVIEW_MAX_CHARS`). */
	preview: string;
	/** A última mensagem é este bot enviando algo a outro bot (ícone de envio). */
	previewSent: boolean;
	/** A última mensagem é um card: ícone do tipo (a `preview` é o título). `null` em texto e em cache antigo. */
	previewCard: CardIconKey | null;
};

export type SectionRef = { id: string; name: string; order: number };
export type HomeSnapshot = { bots: HomeBot[]; sections: SectionRef[] };
