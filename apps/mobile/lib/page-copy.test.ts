import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatItem } from "./chat-types";
import { pageCardSummary } from "./web-card";

// O vitest roda com a raiz em apps/mobile.
const at = (path: string) => join(process.cwd(), path);
const read = (path: string) => readFileSync(at(path), "utf8");
/** Tira comentários: o código pode falar de "página" (do web, da paginação); o que conta é o texto da tela. */
const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");

const files = [
	"components/chat/cards.tsx",
	"lib/web-card.ts",
	"lib/chat-types.ts",
	"app/(app)/pages/[id].tsx",
	"components/ui/content-sheet.tsx",
	...readdirSync(at("components/viewer")).filter((name) => name.endsWith(".tsx")).map((name) => `components/viewer/${name}`),
	...readdirSync(at("components/page")).filter((name) => name.endsWith(".tsx")).map((name) => `components/page/${name}`),
	...readdirSync(at("components/page/charts")).filter((name) => name.endsWith(".tsx")).map((name) => `components/page/charts/${name}`),
];

describe("o usuário vê Painel, nunca Página", () => {
	it("nenhum texto de tela do cartão do chat nem da tela do painel diz 'Página'", () => {
		for (const file of files) {
			expect(withoutComments(read(file)), file).not.toMatch(/p[áa]gina/i);
		}
	});
	it("o cartão do chat resume como 'Painel' e abre como 'Abrir painel'", () => {
		const card = { id: "1", kind: "web-card", card: "page", title: "Vendas", key: "page:p1", pageId: "p1", sourceCount: 2 } as Extract<ChatItem, { kind: "web-card" }>;
		expect(pageCardSummary(card)).toBe("Painel · 2 fontes");
		const cards = withoutComments(read("components/chat/cards.tsx"));
		expect(cards).toContain("Abrir painel");
		expect(cards).toContain("Abrir no navegador");
	});
	it("a tela do painel tem 'Painel' como título provisório e 'Fechar' no botão do topo", () => {
		const screen = withoutComments(read("components/page/page-screen.tsx"));
		const content = withoutComments(read("components/page/page-content.tsx"));
		expect(content).toContain('"Painel"');
		expect(screen).toContain('label="Fechar"');
		expect(content).toContain("Carregando painel");
	});
	it("o botão de compartilhar só existe com ação (o app ainda não tem link público do painel)", () => {
		const screen = withoutComments(read("components/page/page-screen.tsx"));
		expect(screen).toMatch(/onShare\s*\?/);
		expect(read("app/(app)/pages/[id].tsx")).not.toContain("onShare");
	});
});
