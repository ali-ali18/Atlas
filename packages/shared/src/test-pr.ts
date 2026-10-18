import { normalizeEnvRepo } from "./dev-environment.js";

/**
 * "Testar uma PR": entende o que o usuário digita ou cola (URL do GitHub,
 * dono/nome#número, #número ou só o número) e monta a mensagem para o bot.
 */

export type TestPrReference = { repo?: string; number?: number };

const PR_URL = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})\/pull\/([0-9]{1,9})(?:[/?#].*)?$/i;
const REPO_HASH = /^([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100})\s*#([0-9]{1,9})$/;
const NUMBER = /^#?([0-9]{1,9})$/;

/** `null` = não parece uma PR. */
export function parseTestPrInput(input: string): TestPrReference | null {
	const text = input.trim();
	if (!text) return null;
	const url = PR_URL.exec(text);
	if (url) {
		const repo = normalizeEnvRepo(`${url[1]}/${url[2]}`);
		const number = Number(url[3]);
		return repo && number > 0 ? { repo, number } : null;
	}
	const pair = REPO_HASH.exec(text);
	if (pair) {
		const repo = normalizeEnvRepo(pair[1]);
		const number = Number(pair[2]);
		return repo && number > 0 ? { repo, number } : null;
	}
	const bare = NUMBER.exec(text);
	if (bare) {
		const number = Number(bare[1]);
		return number > 0 ? { number } : null;
	}
	return null;
}

/** Mensagem pronta para o bot (o texto também é lido pelo agente como pedido do usuário). */
export function buildTestPrMessage(input: { repo: string; number: number }): string {
	return `Testa a PR #${input.number} de ${input.repo}: faça checkout, instale, rode testes/typecheck/lint/build, veja o CI e diga se pode dar merge.`;
}

/** Os dois campos do diálogo: o que falta ou a mensagem. */
export function resolveTestPrForm(repoText: string, prText: string): { ok: true; message: string; repo: string; number: number } | { ok: false; error: string } {
	const fromPr = parseTestPrInput(prText);
	if (!fromPr?.number) return { ok: false, error: "Informe o número da PR ou cole o link." };
	const repo = fromPr.repo ?? normalizeEnvRepo(repoText);
	if (!repo) return { ok: false, error: "Escolha o repositório (dono/nome)." };
	return { ok: true, repo, number: fromPr.number, message: buildTestPrMessage({ repo, number: fromPr.number }) };
}
