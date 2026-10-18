// Gera src/skills/builtin/generated.ts a partir dos .md da pasta (o build do tsc não copia .md).
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const BUILTIN_DIR = join(here, "..", "src", "skills", "builtin");
export const GENERATED_FILE = join(BUILTIN_DIR, "generated.ts");

/** Conteúdo determinístico do módulo gerado: arquivos em ordem alfabética, texto como string JSON, LF fixo, sem timestamp. */
export function renderGenerated(dir = BUILTIN_DIR) {
	const files = readdirSync(dir)
		.filter((file) => file.endsWith(".md") && !file.startsWith("_"))
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); // ordem por code unit, independente de locale
	const entries = files.map((file) => {
		const text = readFileSync(join(dir, file), "utf8").replace(/\r\n?/g, "\n");
		return `\t${JSON.stringify(file.slice(0, -3))}: ${JSON.stringify(text)},`;
	});
	return [
		"// GERADO por scripts/gen-builtin-skills.mjs a partir dos .md desta pasta. Não edite à mão.",
		"export const BUILTIN_SKILL_SOURCES: Readonly<Record<string, string>> = {",
		...entries,
		"};",
		"",
	].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const found = readdirSync(BUILTIN_DIR).filter((file) => file.endsWith(".md") && !file.startsWith("_")).length;
	if (found === 0) {
		// Sem os .md (contexto de build que os ignora): mantém o generated.ts versionado em vez de esvaziá-lo.
		console.warn("gen-builtin-skills: nenhum .md encontrado; mantendo generated.ts existente");
	} else {
		// Só escreve se mudou (LF fixo, sem timestamp): build repetido não suja o tree nem o mtime.
		const next = renderGenerated();
		const current = existsSync(GENERATED_FILE) ? readFileSync(GENERATED_FILE, "utf8") : null;
		if (current !== next) writeFileSync(GENERATED_FILE, next);
	}
}
