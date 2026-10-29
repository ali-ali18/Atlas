// Guarda da base visual: tamanho de texto, raio e cor em px/hex soltos na className
// só podem DIMINUIR. Use os tokens (`text-body`, `text-caption`, `rounded-card`,
// `rounded-panel`, `text-success`…) ou as escalas do Tailwind. Ver `.agents/rules/35-componentes.md`.
//
// BASELINE = dívida conhecida (arquivo -> contagem máxima por regra). Arquivo fora da
// lista tem limite 0. Ao migrar, baixe o número (o teste também falha se a contagem
// cair e o baseline ficar maior, para o número nunca subir de novo).
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

type Rule = "textPx" | "roundedPx" | "hex";
type Counts = Partial<Record<Rule, number>>;

const RULES: Record<Rule, RegExp> = {
	textPx: /\btext-\[\d+(?:\.\d+)?px\]/g,
	roundedPx: /\brounded(?:-[a-z]{1,2})?-\[\d+(?:\.\d+)?px\]/g,
	hex: /\b(?:bg|text|border|fill|stroke|from|to|via|ring|outline|shadow|decoration|caret|accent)-\[[^\]"'`\s]*#[0-9a-fA-F]{3,8}/g,
};

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const ROOTS = ["apps/web/components", "apps/web/app", "packages/ui/src"];

/**
 * Dívida permitida. Motivos:
 * - lightbox e visualizador do sandbox: fundo escuro fixo, independente do tema;
 * - badge do bot principal: cor de marca (laranja + branco);
 * - 9/10/12/15/17/22px: tamanhos raros sem token (decidir na fase de cards);
 * - rounded-[2px]: setinha de tooltip e legenda de gráfico.
 */
const BASELINE: Record<string, Counts> = {
	"apps/web/components/ai-elements/bot-messages/bot-exchange-view.tsx": { textPx: 1 },
	"apps/web/components/ai-elements/confirm/bot-profile-confirm-card.tsx": { textPx: 1 },
	"apps/web/components/ai-elements/connectors/app-logo.tsx": { textPx: 1 },
	"apps/web/components/ai-elements/images/image-card.tsx": { textPx: 1 },
	"apps/web/components/ai-elements/images/image-lightbox.tsx": { hex: 11 },
	"apps/web/components/ai-elements/subagents/subagent-detail.tsx": { textPx: 1 },
	"apps/web/components/settings/sections/github-app.tsx": { textPx: 1 },
	"apps/web/components/settings/sections/vault.tsx": { textPx: 2 },
	"apps/web/components/settings/settings-dialog.tsx": { textPx: 1 },
	"apps/web/components/ui/templates/template-4/chat-context-panel/chat-context-panel.tsx": { textPx: 2 },
	"apps/web/components/ui/templates/template-4/chat-sidebar/pinned-bot-button.tsx": { textPx: 1 },
	"apps/web/components/ui/templates/template-4/chat-thread/chat-add-menu.tsx": { textPx: 1 },
	"apps/web/components/ui/templates/template-4/chat-thread/composer-image-attachments.tsx": { textPx: 2 },
	"apps/web/components/ui/templates/template-4/chat-thread/mention-popup.tsx": { textPx: 1 },
	"apps/web/components/ui/templates/template-4/chat-thread/questionnaire-card.tsx": { textPx: 1 },
	"apps/web/components/ui/templates/template-4/marketplace/marketplace-page.tsx": { textPx: 1 },
	"apps/web/components/ui/templates/template-4/primary-bot-badge.tsx": { hex: 2 },
	"packages/ui/src/charts/area-value-labels.tsx": { textPx: 1 },
	"packages/ui/src/charts/markers/chart-markers.tsx": { textPx: 1 },
	"packages/ui/src/components/chart.tsx": { roundedPx: 1 },
	"packages/ui/src/components/model-capability-badges.tsx": { textPx: 1 },
	"packages/ui/src/components/tooltip.tsx": { roundedPx: 1 },
};

function walk(dir: string, out: string[]): void {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === ".next") continue;
		const full = join(dir, name);
		if (statSync(full).isDirectory()) walk(full, out);
		else if (/\.(tsx|ts)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
	}
}

function scan(): Record<string, Counts> {
	const files: string[] = [];
	for (const root of ROOTS) walk(join(REPO, root), files);
	const found: Record<string, Counts> = {};
	for (const file of files) {
		const src = readFileSync(file, "utf8");
		const counts: Counts = {};
		for (const rule of Object.keys(RULES) as Rule[]) {
			const n = src.match(RULES[rule])?.length ?? 0;
			if (n > 0) counts[rule] = n;
		}
		if (Object.keys(counts).length > 0) found[relative(REPO, file).split(sep).join("/")] = counts;
	}
	return found;
}

test("base visual: px e hex soltos não crescem (use os tokens)", () => {
	const found = scan();
	if (process.env.PRINT_VISUAL_BASELINE) console.log(JSON.stringify(found, null, "\t"));
	const over: string[] = [];
	const stale: string[] = [];
	const paths = new Set([...Object.keys(found), ...Object.keys(BASELINE)]);
	for (const path of [...paths].sort()) {
		for (const rule of Object.keys(RULES) as Rule[]) {
			const actual = found[path]?.[rule] ?? 0;
			const allowed = BASELINE[path]?.[rule] ?? 0;
			if (actual > allowed) over.push(`${path}: ${rule} ${actual} (máximo ${allowed})`);
			if (actual < allowed) stale.push(`${path}: ${rule} caiu para ${actual}, baixe o baseline (era ${allowed})`);
		}
	}
	assert.deepEqual(over, [], `Use text-body/text-caption/rounded-card/rounded-panel/tokens de cor em vez de px ou hex:\n${over.join("\n")}`);
	assert.deepEqual(stale, [], `Baseline desatualizado (o número só pode cair):\n${stale.join("\n")}`);
});

test("a guarda enxerga os padrões proibidos", () => {
	assert.equal("text-[13px] text-[9.5px]".match(RULES.textPx)?.length, 2);
	assert.equal("rounded-[12px] rounded-t-[4px]".match(RULES.roundedPx)?.length, 2);
	assert.equal('bg-[#ff9800] border-[#fcfcfc1a] shadow-[0_0_0_1px_#fff]'.match(RULES.hex)?.length, 3);
	assert.equal("text-body rounded-card text-[var(--x)] bg-[oklch(0.9_0_0)]".match(RULES.textPx), null);
});
