import type { HomeSnapshot } from "./home-types";

/** Dado de mentira para prévia web (`EXPO_PUBLIC_PREVIEW_HOME=1`, só em `__DEV__`). */
export const PREVIEW_HOME_SNAPSHOT: HomeSnapshot = {
	sections: [
		{ id: "s-cod", name: "Códigos", order: 0 },
		{ id: "s-fac", name: "Faculdade", order: 1 },
		{ id: "s-trab", name: "Trabalho", order: 2 },
		{ id: "s-fin", name: "Finanças", order: 3 },
	],
	bots: [
		{ id: "b1", name: "Cookie", color: "#3b82f6", shape: "blob", pinned: true, pinOrder: 0, sectionId: null, memberIds: [], isPrimary: true, conversationId: "c1", language: null, unread: false, lastAt: new Date().toISOString(), preview: "Rotina: Monitorar Bling Sync", previewSent: false },
		{ id: "b2", name: "Adolfinho", color: "#f97316", shape: "blob", pinned: false, pinOrder: null, sectionId: "s-cod", memberIds: [], isPrimary: false, conversationId: "c2", language: null, unread: true, lastAt: new Date().toISOString(), preview: "Resumo do deploy", previewSent: false },
		{ id: "b3", name: "Bobinho", color: "#ef4444", shape: "blob", pinned: false, pinOrder: null, sectionId: "s-cod", memberIds: [], isPrimary: false, conversationId: "c3", language: null, unread: false, lastAt: new Date(Date.now() - 86_400_000).toISOString(), preview: "Ontem: revisão de PR", previewSent: false },
	],
};

export function previewHomeEnabled(): boolean {
	return typeof __DEV__ !== "undefined" && __DEV__ && process.env.EXPO_PUBLIC_PREVIEW_HOME === "1";
}
