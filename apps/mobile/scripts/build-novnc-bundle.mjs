// Empacota o core do noVNC (RFB, com o pako do próprio pacote) num único módulo ES (que expõe `window.NoVNC`) e grava `lib/novnc-bundle.generated.ts`,
// que o app carrega como string dentro da WebView (funciona no Expo Go e no EAS Update, sem módulo nativo).
// Os arquivos do noVNC entram SEM modificação (MPL-2.0, ver THIRD_PARTY_NOTICES.md).
//
//   pnpm --filter @workspace/mobile build:novnc
//
// O arquivo gerado grava a versão do noVNC, o hash das ENTRADAS (versões do noVNC e do esbuild + este script) e o hash do conteúdo gerado; o
// teste `lib/novnc-bundle.test.ts` falha se o pacote ou este script mudarem sem regerar.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, version as esbuildVersion } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const novnc = path.join(root, "node_modules", "@novnc", "novnc");
const outFile = path.join(root, "lib", "novnc-bundle.generated.ts");

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const version = JSON.parse(readFileSync(path.join(novnc, "package.json"), "utf8")).version;
const scriptText = readFileSync(fileURLToPath(import.meta.url), "utf8");
/** Mesma conta que o teste refaz: versão do noVNC + versão do esbuild (a saída depende dela) + texto deste script. */
const inputsHash = sha256(`${version}\n${esbuildVersion}\n${scriptText}`);

// O `exports` do pacote só libera `core/rfb.js`; o resto entra por caminho de arquivo.
// O core 1.7 tem `await` no topo (`core/util/browser.js`, detecção de H.264), que o esbuild não aceita em IIFE: por isso o
// bundle sai em ESM (`format: "esm"`, `target: es2022`) e a página o embute em `<script type="module">`. Sem alterar o noVNC.
// O noVNC loga `connecting to <url>` (com o token do WebSocket) no nível Info: o log é desligado de forma explícita
// (`initLogging("none")`) antes de qualquer conexão, em vez de depender do nível padrão.
const entry = [
	`import RFB from ${JSON.stringify(path.join(novnc, "core", "rfb.js"))};`,
	`import * as Log from ${JSON.stringify(path.join(novnc, "core", "util", "logging.js"))};`,
	'Log.initLogging("none");',
	"window.NoVNC = { RFB };",
	"if (window.__bridge) window.__bridge.ready();",
].join("\n");
const banner = `/* noVNC ${version} (core), MPL-2.0, sem modificação: https://github.com/novnc/noVNC/tree/v${version}. Ver THIRD_PARTY_NOTICES.md. */`;

{
	const result = await build({
		stdin: { contents: entry, resolveDir: root, loader: "js" },
		bundle: true,
		format: "esm",
		platform: "browser",
		target: "es2022",
		minify: true,
		legalComments: "none",
		banner: { js: banner },
		write: false,
	});
	const bundle = result.outputFiles[0].text;
	// A página embute o bundle num <script>: não pode ter o fechamento de script no meio.
	if (/<\/script/i.test(bundle)) throw new Error("O bundle contém </script; ajuste a build.");
	const body = [
		"// GERADO por scripts/build-novnc-bundle.mjs: não edite à mão (pnpm --filter @workspace/mobile build:novnc).",
		`// noVNC core ${version} (MPL-2.0), sem modificação. Ver THIRD_PARTY_NOTICES.md.`,
		`export const NOVNC_VERSION = ${JSON.stringify(version)};`,
		`export const NOVNC_INPUTS_HASH = ${JSON.stringify(inputsHash)};`,
		`export const NOVNC_BUNDLE_SHA256 = ${JSON.stringify(sha256(bundle))};`,
		`export const NOVNC_BUNDLE = ${JSON.stringify(bundle)};`,
		"",
	].join("\n");
	writeFileSync(outFile, body);
	console.log(`noVNC ${version}: ${bundle.length} bytes (min) -> ${path.relative(root, outFile)}`);
}
