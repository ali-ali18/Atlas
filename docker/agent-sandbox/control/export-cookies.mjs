// Exporta os cookies do Chrome da sandbox (via CDP) aplicáveis a uma URL para um
// cookie jar Netscape que o curl entende (-b). Roda como root (chamado pelo
// host com exec fixo); o jar é entregue ao usuário `atlas` com modo 0600.
// Uso: node export-cookies.mjs <url> <jar-path>
import { chmodSync, writeFileSync } from "node:fs";

export function toNetscape(cookies) {
	const lines = ["# Netscape HTTP Cookie File"];
	for (const c of cookies) {
		const domain = `${c.httpOnly ? "#HttpOnly_" : ""}${c.domain}`;
		const sub = c.domain.startsWith(".") ? "TRUE" : "FALSE";
		const expires = c.expires && c.expires > 0 ? Math.floor(c.expires) : 0;
		lines.push([domain, sub, c.path || "/", c.secure ? "TRUE" : "FALSE", expires, c.name, c.value].join("\t"));
	}
	return `${lines.join("\n")}\n`;
}

async function main() {
	const [url, jar] = process.argv.slice(2);
	if (!url || !jar) throw new Error("usage: export-cookies.mjs <url> <jar>");
	const { chromium } = await import("playwright-core");
	const cdp = process.env.CDP_URL || "http://127.0.0.1:9222";
	const browser = await chromium.connectOverCDP(cdp, { timeout: 5000 });
	try {
		const cookies = (await Promise.all(browser.contexts().map((ctx) => ctx.cookies([url])))).flat();
		writeFileSync(jar, toNetscape(cookies), { mode: 0o600 });
		chmodSync(jar, 0o600);
		console.log(`cookies:${cookies.length}`);
	} finally {
		await browser.close().catch(() => undefined);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
