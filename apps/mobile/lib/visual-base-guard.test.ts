// Guarda da pele do app: cor em hex só existe nos arquivos de tokens (`lib/surfaces.ts`, `lib/color-tokens.ts`); o resto
// usa `useSurfaces()`, os tokens do tema (`bg-background`, `text-muted-foreground`…) ou as peças de `components/ui/`.
// E o `Switch` do react-native não pode ser importado: o único interruptor é `components/ui/toggle-switch.tsx`.
// Ver "App mobile (apps/mobile): pele e peças" em `.agents/rules/35-componentes.md`.
//
// BASELINE = dívida conhecida (arquivo -> hex permitidos). Arquivo fora da lista e fora dos tokens tem limite 0. O número
// só pode CAIR: o teste também falha se a contagem real ficar abaixo do baseline (baixe o número no mesmo commit).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const DIRS = ["app", "components", "lib"];

/** Arquivos que DEFINEM cor (a única fonte). */
const TOKEN_FILES = new Set(["lib/surfaces.ts", "lib/color-tokens.ts"]);

/**
 * Dívida permitida, com motivo:
 * - splash e mascote: o splash nativo é escuro e fixo nos dois temas (`app.json`), e o branco do mascote é marca;
 * - ícones e avatar: cores de desenho (olhos, estrela, formas), não de pele de tela;
 * - bot-edit: o branco da paleta de cores do avatar do bot (cor de marca do bot, não de pele de tela);
 * - bot-avatar: laranja do selo do bot principal (cor de marca, igual ao web);
 * - bubble-tone: tons do balão do usuário na cor do bot (cálculo de cor do bot, não da pele);
 * - chart-palette: paletas dos gráficos (cores de dado, espelham as do web, não da pele);
 * - Computador (tela, menu, WebView, página do viewer e rota): a imagem da VM é preta e a tela é sempre escura nos dois
 *   temas (padrão do Grok), então branco/cinza/preto fixos são de desenho, não da pele; a página do viewer é HTML/CSS embutido;
 * - icons: o "G" do Google (4 cores de marca) e os ícones do Computador (branco/cinza fixos sobre a tela preta);
 * - color-math: valores de teste/exemplo de contraste e mistura, não da pele.
 */
const BASELINE: Record<string, number> = {
	"components/home/bot-avatar.tsx": 4,
	"lib/bot-edit.ts": 1,
	"app/(app)/computer/[id].tsx": 2,
	"components/computer/computer-menu.tsx": 3,
	"components/computer/computer-view.tsx": 10,
	"components/computer/viewer-webview.tsx": 3,
	"components/icons.tsx": 12,
	"components/splash-screen.tsx": 2,
	"components/ui/avatar.tsx": 2,
	"lib/bubble-tone.ts": 4,
	"lib/chart-palette.ts": 91,
	"lib/color-math.ts": 2,
	"lib/viewer-page.ts": 3,
	"lib/theme.ts": 1,
};

const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const RN_SWITCH = /import\s*\{[^}]*\bSwitch\b[^}]*\}\s*from\s*["']react-native["']/;

function sources(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules") continue;
		const full = join(dir, name);
		if (statSync(full).isDirectory()) sources(full, out);
		else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) out.push(full);
	}
	return out;
}

const FILES = DIRS.flatMap((dir) => sources(join(ROOT, dir))).map((full) => ({ path: relative(ROOT, full).split(sep).join("/"), text: readFileSync(full, "utf8") }));

describe("guarda visual do app mobile", () => {
	it("não há hex novo fora dos arquivos de tokens (e o baseline só cai)", () => {
		const over: string[] = [];
		const stale: string[] = [];
		for (const file of FILES) {
			if (TOKEN_FILES.has(file.path)) continue;
			const found = (file.text.match(HEX) ?? []).length;
			const allowed = BASELINE[file.path] ?? 0;
			if (found > allowed) over.push(`${file.path}: ${found} hex (permitido ${allowed}). Use useSurfaces()/tokens.`);
			else if (found < allowed) stale.push(`${file.path}: ${found} hex, baseline ${allowed}. Baixe o baseline.`);
		}
		expect(over).toEqual([]);
		expect(stale).toEqual([]);
	});

	it("o baseline não lista arquivo que não existe", () => {
		const known = new Set(FILES.map((file) => file.path));
		expect(Object.keys(BASELINE).filter((path) => !known.has(path))).toEqual([]);
	});

	it("o Switch do react-native não é importado (use components/ui/toggle-switch.tsx)", () => {
		const offenders = FILES.filter((file) => file.path !== "components/ui/toggle-switch.tsx" && RN_SWITCH.test(file.text)).map((file) => file.path);
		expect(offenders).toEqual([]);
	});
});
