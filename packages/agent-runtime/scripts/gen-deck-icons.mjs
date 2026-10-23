// Gera src/files/deck/icon-data.ts a partir do lucide-react (ISC) já usado em packages/ui.
// Uso: node scripts/gen-deck-icons.mjs  (ao mudar a lista, atualize DECK_ICON_NAMES em packages/shared/src/deck-free.ts).
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../../ui/package.json"));
const lucideRoot = path.dirname(require.resolve("lucide-react/package.json"));
const ICONS = "rocket target users user chart-line chart-column chart-pie trending-up trending-down dollar-sign wallet credit-card shopping-cart store package truck globe map-pin building-2 house factory wheat leaf sprout tractor sun droplets zap battery lightbulb cpu code database cloud shield-check lock key settings wrench hammer clock calendar check circle-check x triangle-alert info star heart thumbs-up award trophy flag handshake megaphone mail phone message-circle link search eye graduation-cap book-open file-text camera image play smartphone laptop wifi scale percent arrow-right repeat layers puzzle sparkles brain banknote receipt clipboard-list briefcase coins".split(" ");

const out = {};
for (const name of ICONS) {
	let source = await readFile(path.join(lucideRoot, "dist/esm/icons", `${name}.mjs`), "utf8");
	// Apelidos (building-2 -> building-complex) só reexportam o ícone real.
	for (let hop = 0; hop < 3; hop++) {
		const alias = /export \{ default \} from '\.\/([\w-]+)\.mjs'/.exec(source);
		if (!alias) break;
		source = await readFile(path.join(lucideRoot, "dist/esm/icons", `${alias[1]}.mjs`), "utf8");
	}
	const match = /const __iconData = (\{[\s\S]*?\n\});\n/.exec(source);
	if (!match) throw new Error(`icon ${name}: node not found`);
	const nodes = Function(`return ${match[1]}`)().node;
	out[name] = nodes.map(([tag, attrs]) => {
		const { key: _key, ...rest } = attrs;
		return [tag, rest];
	});
}
const body = JSON.stringify(out).replace(/\],"/g, '],\n\t"');
await writeFile(
	path.join(here, "../src/files/deck/icon-data.ts"),
	`// Gerado por scripts/gen-deck-icons.mjs a partir do lucide-react (licença ISC, https://lucide.dev). Não edite à mão.\nexport type IconNode = Array<[string, Record<string, string>]>;\n\nexport const ICON_NODES: Record<string, IconNode> = {\n\t${body.slice(1, -1)},\n};\n`,
);
console.log(`${ICONS.length} ícones`);
console.log(ICONS.join(" "));
