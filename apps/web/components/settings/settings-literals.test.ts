import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * Arquivos de Configurações já traduzidos: nenhum texto em pt-BR escrito direto no código
 * (tudo vem do dicionário). Comentários podem ter acento; o resto não.
 */
const TRANSLATED = [
	"components/settings/diagnostics-state.ts",
	"components/settings/usage-state.ts",
	"components/settings/reflection-state.ts",
	"components/settings/sections/diagnostics.tsx",
	"components/settings/sections/usage.tsx",
	"components/settings/sections/reflection.tsx",
	"components/settings/sections/timezone.tsx",
	"components/settings/sections/work-hours.tsx",
	"components/settings/providers-state.ts",
	"components/settings/models-state.ts",
	"components/settings/sections/providers.tsx",
	"components/settings/sections/provider-keys.tsx",
	"components/settings/sections/email-key.tsx",
	"components/settings/sections/email-domains.tsx",
	"components/settings/sections/notifications.tsx",
	"components/settings/sections/models.tsx",
	"components/settings/sections/model-tiers.tsx",
	"components/settings/jev-execution-state.ts",
	"components/settings/sections/execution.tsx",
	"components/settings/sections/jev.tsx",
	"components/settings/vault-state.ts",
	"components/settings/sections/vault.tsx",
	"components/settings/sections/dev-environments.tsx",
	"components/settings/github-app-state.ts",
	"components/settings/sections/github-app.tsx",
	"components/settings/sections/skills.tsx",
	"components/settings/sections/skills/skills-list-view.tsx",
	"components/settings/sections/skills/skill-row.tsx",
	"components/settings/sections/skills/skill-editor-view.tsx",
	"components/settings/sections/skills/builtin-skill-view.tsx",
	"components/settings/sections/skills/skill-markdown-preview.tsx",
];

const ACCENTED = /[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]/;

function code(file: string): string {
	return readFileSync(join(process.cwd(), file), "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.map((line) => line.replace(/(^|\s)\/\/.*$/, ""))
		.join("\n");
}

test("telas de Configurações traduzidas não têm texto pt-BR fixo no código", () => {
	for (const file of TRANSLATED) {
		const offending = code(file)
			.split("\n")
			.filter((line) => ACCENTED.test(line) && !/recordVaultCopy|revealVaultItem/.test(line));
		assert.deepEqual(offending, [], `${file} tem texto fixo em pt-BR`);
	}
});
