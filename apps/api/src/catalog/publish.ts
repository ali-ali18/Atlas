import { createHash } from "node:crypto";
import {
	CATALOG_REPO,
	buildCatalogManifest,
	renderSkillMarkdown,
	summarizeTextDiff,
	type CatalogIndex,
	type CatalogPublishInput,
	type CatalogSkillEntry,
	type TextDiff,
} from "@workspace/shared";

/**
 * Publicação de uma skill no catálogo: monta SKILL.md + manifest.json + índice
 * e abre um PR no repo do catálogo com o token do GitHub do próprio usuário
 * (fork -> branch -> arquivos -> PR). Sem fork/escrita possível, quem chama cai
 * no "Baixar pacote". Nunca envia nada além do conteúdo da skill.
 */

const API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

export type PublishFile = { path: string; content: string };

export type SkillPackage = {
	slug: string;
	files: PublishFile[];
	/** Conteúdo novo do índice. */
	index: CatalogIndex;
	manifest: ReturnType<typeof buildCatalogManifest>;
	skillMarkdown: string;
};

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** Mesma formatação do scripts/build-index.mjs do catálogo (a CI compara byte a byte). */
export function serializeIndex(index: CatalogIndex): string {
	return `${JSON.stringify(index, null, 2)}\n`;
}

export function buildSkillPackage(input: CatalogPublishInput, currentIndex: CatalogIndex | null): SkillPackage {
	const slug = input.name;
	const manifest = buildCatalogManifest(input);
	const skillMarkdown = renderSkillMarkdown({ name: slug, description: input.description.trim(), tools: input.tools, body: input.body });
	const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
	const entry: CatalogSkillEntry = {
		slug,
		name: manifest.name,
		description: manifest.description,
		version: manifest.version,
		author: manifest.author,
		category: manifest.category,
		tags: manifest.tags,
		tools: manifest.tools,
		path: `skills/${slug}`,
		sha256: sha256(skillMarkdown),
		manifestSha256: sha256(manifestText),
	};
	const skills = [...(currentIndex?.skills ?? []).filter((item) => item.slug !== slug), entry].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
	const index: CatalogIndex = { schemaVersion: 1, skills, bots: currentIndex?.bots ?? [] };
	return {
		slug,
		manifest,
		skillMarkdown,
		index,
		files: [
			{ path: `skills/${slug}/SKILL.md`, content: skillMarkdown },
			{ path: `skills/${slug}/manifest.json`, content: manifestText },
			{ path: "index.json", content: serializeIndex(index) },
		],
	};
}

export function pullRequestBody(input: { pkg: SkillPackage; update: boolean; diff: TextDiff | null; previousVersion: string | null }): string {
	const { pkg, update, diff, previousVersion } = input;
	const lines = [
		`## ${update ? "Atualização" : "Nova skill"}: ${pkg.manifest.name} ${pkg.manifest.version}`,
		"",
		pkg.manifest.description,
		"",
		`- Categoria: ${pkg.manifest.category}`,
		`- Autor: ${pkg.manifest.author}`,
		`- Ferramentas sugeridas (dica, não concede permissão): ${pkg.manifest.tools.length ? pkg.manifest.tools.join(", ") : "nenhuma"}`,
		"",
		"### O que mudou",
		pkg.manifest.changelog[0]?.notes ?? "",
	];
	if (update && diff) {
		lines.push("", `### Diferença em relação à versão ${previousVersion ?? "anterior"}`, "", `+${diff.added} / -${diff.removed} linhas`);
		if (diff.preview.length > 0) lines.push("", "```diff", ...diff.preview, "```");
	}
	lines.push("", "---", "Enviado pelo app. A varredura de instruções suspeitas rodou antes do envio; a CI do repositório roda de novo.", "");
	return lines.join("\n");
}

export type PublishDeps = {
	fetchFn?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	repo?: string;
	now?: () => number;
};

export type PublishResult =
	| { ok: true; url: string; number: number; branch: string }
	| { ok: false; reason: "permissions" | "unavailable"; message: string };

class GithubFailure extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export async function openCatalogPullRequest(
	input: { token: string; login: string; pkg: SkillPackage; title: string; body: string },
	deps: PublishDeps = {},
): Promise<PublishResult> {
	const fetchFn = deps.fetchFn ?? fetch;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const upstream = deps.repo ?? CATALOG_REPO;
	const now = deps.now ?? Date.now;

	async function call<T>(method: string, path: string, body?: unknown, okStatuses: number[] = [200, 201, 202]): Promise<{ status: number; data: T }> {
		const response = await fetchFn(`${API}${path}`, {
			method,
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${input.token}`,
				"X-GitHub-Api-Version": GITHUB_API_VERSION,
				"User-Agent": "atlas-agent-catalog",
				...(body !== undefined ? { "Content-Type": "application/json" } : {}),
			},
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		});
		const text = await response.text().catch(() => "");
		let data: unknown = {};
		try {
			data = text ? JSON.parse(text) : {};
		} catch {
			data = {};
		}
		if (!okStatuses.includes(response.status)) {
			const message = typeof (data as { message?: unknown }).message === "string" ? (data as { message: string }).message : `HTTP ${response.status}`;
			throw new GithubFailure(response.status, message);
		}
		return { status: response.status, data: data as T };
	}

	try {
		const repoInfo = await call<{ default_branch: string }>("GET", `/repos/${upstream}`);
		const base = repoInfo.data.default_branch || "main";
		const owner = upstream.split("/")[0] ?? "";
		let target = upstream;
		if (owner.toLowerCase() !== input.login.toLowerCase()) {
			const fork = await call<{ full_name: string }>("POST", `/repos/${upstream}/forks`, {});
			target = fork.data.full_name;
			let ready = false;
			for (let attempt = 0; attempt < 8 && !ready; attempt++) {
				try {
					await call("GET", `/repos/${target}`);
					ready = true;
				} catch (error) {
					if (!(error instanceof GithubFailure) || error.status !== 404) throw error;
					await sleep(1500);
				}
			}
			if (!ready) return { ok: false, reason: "unavailable", message: "O fork ainda não ficou pronto. Tente de novo em instantes." };
		}

		const head = await call<{ object: { sha: string } }>("GET", `/repos/${upstream}/git/ref/heads/${encodeURIComponent(base)}`);
		const branch = `skill/${input.pkg.slug}-${input.pkg.manifest.version}-${now().toString(36)}`;
		await call("POST", `/repos/${target}/git/refs`, { ref: `refs/heads/${branch}`, sha: head.data.object.sha });

		for (const file of input.pkg.files) {
			let sha: string | undefined;
			try {
				const existing = await call<{ sha?: string }>("GET", `/repos/${target}/contents/${file.path}?ref=${encodeURIComponent(branch)}`);
				sha = existing.data.sha;
			} catch (error) {
				if (!(error instanceof GithubFailure) || error.status !== 404) throw error;
			}
			await call("PUT", `/repos/${target}/contents/${file.path}`, {
				message: `${input.title} (${file.path})`,
				content: Buffer.from(file.content, "utf8").toString("base64"),
				branch,
				...(sha ? { sha } : {}),
			});
		}

		const pull = await call<{ html_url: string; number: number }>("POST", `/repos/${upstream}/pulls`, {
			title: input.title,
			head: target === upstream ? branch : `${target.split("/")[0]}:${branch}`,
			base,
			body: input.body,
			maintainer_can_modify: true,
		});
		return { ok: true, url: pull.data.html_url, number: pull.data.number, branch };
	} catch (error) {
		if (error instanceof GithubFailure) {
			if (error.status === 401 || error.status === 403 || error.status === 404) {
				return { ok: false, reason: "permissions", message: "A conexão com o GitHub não tem permissão para abrir um PR no catálogo." };
			}
			return { ok: false, reason: "unavailable", message: "O GitHub não aceitou o envio agora." };
		}
		return { ok: false, reason: "unavailable", message: "Não consegui falar com o GitHub." };
	}
}

export { summarizeTextDiff };
