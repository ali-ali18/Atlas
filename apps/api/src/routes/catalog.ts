import { Hono, type Context } from "hono";
import {
	SkillDocError,
	appendConversationMessage,
	createBot,
	createSkillDoc,
	getSkillDoc,
	listMcpConnections,
	listSkillDocs,
	updateSkillDoc,
	type SkillDocRecord,
} from "@workspace/db";
import { getGithubToken } from "@workspace/agent-runtime";
import {
	CATALOG_REPO,
	hasBlockingFinding,
	isBotProposalShape,
	redactSecrets,
	isNewerVersion,
	resolveBotProposalColor,
	scanSuspiciousInstructions,
	summarizeTextDiff,
	validateCatalogPublishInput,
	type CatalogPublishInput,
	type ScanFinding,
} from "@workspace/shared";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";
import { validateProviderModel, type ModelValidation } from "../providers/model-catalog.js";
import { CatalogError, createCatalogClient, type CatalogClient } from "../catalog/client.js";
import { buildSkillPackage, openCatalogPullRequest, pullRequestBody, type PublishDeps } from "../catalog/publish.js";

/**
 * Marketplace de skills e agentes. Tudo atrás de `requireUser`; o dono vem da
 * sessão. O conteúdo do catálogo é dado não confiável: validado, com hash
 * conferido e varrido antes de qualquer instalação. Instalar nunca concede
 * ferramenta (a skill instalada é texto; `tools` é só dica).
 */

const STATUS_BY_KIND = { invalid: 400, conflict: 409, stale: 409, limit: 422, not_found: 404 } as const;
const CATALOG_STATUS = { unavailable: 503, invalid: 502, not_found: 404, integrity: 502 } as const;
const NEW_PR_URL = `https://github.com/${CATALOG_REPO}/compare`;

export type CatalogRouteDeps = {
	client?: CatalogClient;
	listSkillDocs?: typeof listSkillDocs;
	getSkillDoc?: typeof getSkillDoc;
	createSkillDoc?: typeof createSkillDoc;
	updateSkillDoc?: typeof updateSkillDoc;
	createBot?: typeof createBot;
	appendMessage?: typeof appendConversationMessage;
	listConnections?: (userId: string) => Promise<{ catalogId: string | null; status: string }[]>;
	validateModel?: (userId: string, model: string) => Promise<ModelValidation>;
	githubToken?: (userId: string) => Promise<{ token: string; login: string } | null>;
	publish?: PublishDeps;
	today?: () => string;
};

type Json = Record<string, unknown>;

function failure(c: Context<AuthEnv>, error: unknown) {
	if (error instanceof CatalogError) return c.json({ error: error.message, code: error.kind }, CATALOG_STATUS[error.kind]);
	if (error instanceof SkillDocError) return c.json({ error: error.message, details: error.details }, STATUS_BY_KIND[error.kind]);
	console.error("catalog failed", error instanceof Error ? error.message : "erro desconhecido");
	return c.json({ error: "Falha ao falar com o marketplace." }, 503);
}

async function body(c: Context<AuthEnv>): Promise<Json> {
	const raw = await c.req.json().catch(() => null);
	return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Json) : {};
}

function scopeOf(raw: unknown): string | null | undefined {
	if (raw === undefined || raw === null || raw === "") return null;
	return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function installView(doc: SkillDocRecord) {
	return { id: doc.id, botId: doc.botId, name: doc.name, version: doc.source?.version ?? "", edited: doc.source?.edited ?? false };
}

function blocked(findings: ScanFinding[]) {
	return {
		error: "O conteúdo tem instruções que o app não instala. Ele não foi instalado.",
		code: "blocked",
		findings: findings.filter((item) => item.severity === "block"),
	};
}

export function createCatalogRoutes(deps: CatalogRouteDeps = {}) {
	const client = deps.client ?? createCatalogClient();
	const listDocs = deps.listSkillDocs ?? listSkillDocs;
	const getDoc = deps.getSkillDoc ?? getSkillDoc;
	const createDoc = deps.createSkillDoc ?? createSkillDoc;
	const updateDoc = deps.updateSkillDoc ?? updateSkillDoc;
	const makeBot = deps.createBot ?? createBot;
	const appendMessage = deps.appendMessage ?? appendConversationMessage;
	const connections =
		deps.listConnections ?? (async (userId: string) => (await listMcpConnections(userId)).map((item) => ({ catalogId: item.catalogId, status: item.status })));
	const validateModel = deps.validateModel ?? validateProviderModel;
	const today = deps.today ?? (() => new Date().toISOString().slice(0, 10));
	const githubToken =
		deps.githubToken ??
		(async (userId: string) => {
			const result = await getGithubToken(userId, { withLogin: true });
			return "error" in result || !result.login ? null : { token: result.token, login: result.login };
		});
	const app = new Hono<AuthEnv>();

	async function installedBySlug(userId: string): Promise<Map<string, SkillDocRecord[]>> {
		const map = new Map<string, SkillDocRecord[]>();
		for (const doc of await listDocs(userId).catch(() => [] as SkillDocRecord[])) {
			if (!doc.source) continue;
			map.set(doc.source.slug, [...(map.get(doc.source.slug) ?? []), doc]);
		}
		return map;
	}

	/** Lista do marketplace + o que o usuário já instalou (e se há versão nova). */
	app.get("/v1/catalog", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		try {
			const index = await client.index();
			const installed = await installedBySlug(userId);
			return c.json({
				skills: index.skills.map((entry) => ({
					...entry,
					installs: (installed.get(entry.slug) ?? []).map((doc) => ({
						...installView(doc),
						updateAvailable: isNewerVersion(entry.version, doc.source?.version ?? "0.0.0"),
					})),
				})),
				bots: index.bots,
			});
		} catch (error) {
			return failure(c, error);
		}
	});

	app.get("/v1/catalog/skills/:slug", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		try {
			const item = await client.skill(c.req.param("slug"));
			const installed = (await installedBySlug(userId)).get(item.entry.slug) ?? [];
			return c.json({
				entry: item.entry,
				changelog: item.manifest.changelog,
				body: item.skill.body,
				tools: item.skill.tools,
				findings: item.findings,
				installs: installed.map((doc) => ({
					...installView(doc),
					updateAvailable: isNewerVersion(item.entry.version, doc.source?.version ?? "0.0.0"),
				})),
			});
		} catch (error) {
			return failure(c, error);
		}
	});

	/**
	 * Instala (ou atualiza) uma skill do catálogo no escopo escolhido. Cópia
	 * editada pelo usuário: sem `mode` responde 409 com o resumo das diferenças;
	 * `mode: "update"` sobrescreve, `mode: "keep"` mantém a dele.
	 */
	app.post("/v1/catalog/skills/:slug/install", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const payload = await body(c);
		const botId = scopeOf(payload.botId);
		if (botId === undefined) return c.json({ error: "botId inválido." }, 400);
		const mode = payload.mode === "update" || payload.mode === "keep" ? payload.mode : undefined;
		try {
			const item = await client.skill(c.req.param("slug"));
			if (hasBlockingFinding(item.findings)) return c.json(blocked(item.findings), 422);
			const source = { kind: "catalog" as const, slug: item.entry.slug, version: item.entry.version };
			const fields = { name: item.skill.name, description: item.skill.description, body: item.skill.body, tools: item.skill.tools };

			const existing = (await listDocs(userId, { botId })).find((doc) => doc.name === item.skill.name);
			if (!existing) {
				const skill = await createDoc(userId, { ...fields, botId, source, createdBy: "user", status: "active", enabled: true });
				return c.json({ action: "installed", skill: installView(skill), id: skill.id }, 201);
			}
			if (existing.source?.slug !== item.entry.slug) {
				return c.json({ error: `Você já tem uma habilidade chamada "${existing.name}" neste escopo. Renomeie ou apague a sua antes de instalar.`, code: "name_taken" }, 409);
			}
			const sameVersion = existing.source.version === item.entry.version;
			if (existing.source.edited) {
				if (mode === "keep") return c.json({ action: "kept", id: existing.id });
				if (mode !== "update") {
					const diff = summarizeTextDiff(existing.body, item.skill.body);
					return c.json(
						{
							error: "Você editou esta habilidade. Escolha se quer sobrescrever com a versão do catálogo.",
							code: "edited",
							installedVersion: existing.source.version,
							catalogVersion: item.entry.version,
							diff,
						},
						409,
					);
				}
			} else if (sameVersion) {
				return c.json({ action: "unchanged", id: existing.id });
			}
			const skill = await updateDoc(userId, existing.id, { ...fields, source, updatedBy: "user" });
			return c.json({ action: "updated", skill: installView(skill), id: skill.id });
		} catch (error) {
			return failure(c, error);
		}
	});

	app.get("/v1/catalog/bots/:slug", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		try {
			const item = await client.bot(c.req.param("slug"));
			const skills = await Promise.all(
				item.bot.skills.map(async (slug) => {
					const found = await client.skill(slug).catch(() => null);
					return found
						? { slug, name: found.manifest.name, description: found.skill.description, version: found.entry.version, tools: found.skill.tools, blocked: hasBlockingFinding(found.findings) }
						: { slug, name: slug, description: "", version: "", tools: [], blocked: true };
				}),
			);
			const connected = new Set((await connections(userId).catch(() => [])).filter((item) => item.status === "connected").map((item) => item.catalogId));
			return c.json({
				entry: item.entry,
				bot: item.bot,
				skills,
				connectors: item.bot.suggestedConnectors.map((connector) => ({ ...connector, connected: connected.has(connector.id) })),
				findings: item.findings,
			});
		} catch (error) {
			return failure(c, error);
		}
	});

	/**
	 * Cria o agente do modelo pelo mesmo `createBot` da proposta de agente,
	 * instala as skills no escopo dele (com origem) e posta a primeira mensagem.
	 * Rotinas NUNCA são criadas aqui: voltam como sugestão escolhida e o web as cria
	 * pela rota de rotinas, só as que o usuário marcou.
	 */
	app.post("/v1/catalog/bots/:slug/install", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const payload = await body(c);
		try {
			const item = await client.bot(c.req.param("slug"));
			if (hasBlockingFinding(item.findings)) return c.json(blocked(item.findings), 422);
			const warnings: string[] = [];

			const rawName = typeof payload.name === "string" ? payload.name.replace(/\s+/g, " ").trim() : "";
			if (payload.name !== undefined && (!rawName || rawName.length > 40)) return c.json({ error: "O nome deve ter de 1 a 40 caracteres." }, 400);
			const color = (payload.color !== undefined && resolveBotProposalColor(payload.color)) || item.bot.color;
			const shape = typeof payload.shape === "string" && isBotProposalShape(payload.shape) ? payload.shape.trim() : item.bot.shape;

			let model: string | null = null;
			if (payload.useSuggestedModel === true && item.bot.suggestedModel) {
				const validation = await validateModel(userId, item.bot.suggestedModel).catch(() => ({ error: "indisponível", status: 503 as const }));
				if ("error" in validation) warnings.push("O modelo sugerido não está disponível; usei o seu modelo padrão.");
				else model = item.bot.suggestedModel;
			}

			const picked = Array.isArray(payload.routines)
				? [...new Set(payload.routines.filter((value): value is number => Number.isInteger(value) && value >= 0 && value < item.bot.starterRoutines.length))]
				: [];

			const bot = await makeBot(
				{ name: rawName || item.bot.name, snippet: item.bot.snippet, color, shape, description: item.bot.description, openRouterModel: model },
				userId,
			);

			const installed: string[] = [];
			for (const slug of item.bot.skills) {
				try {
					const skill = await client.skill(slug);
					if (hasBlockingFinding(skill.findings)) {
						warnings.push(`A habilidade ${slug} foi bloqueada pela varredura e não foi instalada.`);
						continue;
					}
					await createDoc(userId, {
						name: skill.skill.name,
						description: skill.skill.description,
						body: skill.skill.body,
						tools: skill.skill.tools,
						botId: bot.id,
						source: { kind: "catalog", slug: skill.entry.slug, version: skill.entry.version },
						createdBy: "user",
					});
					installed.push(slug);
				} catch {
					warnings.push(`Não consegui instalar a habilidade ${slug}.`);
				}
			}

			if (item.bot.firstMessage && bot.conversationId) {
				await appendMessage(bot.conversationId, "assistant", item.bot.firstMessage).catch(() => warnings.push("Não consegui postar a primeira mensagem."));
			}

			return c.json(
				{
					botId: bot.id,
					name: bot.name,
					installedSkills: installed,
					routines: picked.map((index) => item.bot.starterRoutines[index]),
					...(warnings.length ? { warnings } : {}),
				},
				201,
			);
		} catch (error) {
			return failure(c, error);
		}
	});

	/** Valida o formulário de publicação e monta o pacote (compartilhado por PR e download). */
	async function preparePublish(c: Context<AuthEnv>, userId: string) {
		const payload = await body(c);
		const doc = await getDoc(userId, c.req.param("id") ?? "");
		if (!doc) return { response: c.json({ error: "Habilidade não encontrada." }, 404) } as const;
		const tags = Array.isArray(payload.tags) ? payload.tags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim()) : [];
		const input: CatalogPublishInput = {
			name: doc.name,
			description: doc.description,
			body: doc.body,
			tools: doc.tools,
			author: typeof payload.author === "string" ? payload.author : "",
			version: typeof payload.version === "string" ? payload.version.trim() : "",
			category: typeof payload.category === "string" ? payload.category.trim() : "",
			tags,
			notes: typeof payload.notes === "string" ? payload.notes : "",
			date: today(),
		};
		const errors = validateCatalogPublishInput(input);
		if (errors.length) return { response: c.json({ error: errors.join(" "), details: errors }, 400) } as const;

		const publicText = [doc.name, doc.description, doc.body, input.notes].join("\n");
		if (redactSecrets(publicText) !== publicText) {
			return { response: c.json({ error: "A habilidade parece conter uma chave ou senha. Remova antes de publicar.", code: "secret" }, 422) } as const;
		}
		const findings = scanSuspiciousInstructions([doc.name, doc.description, doc.body, input.notes].join("\n"));
		if (hasBlockingFinding(findings)) return { response: c.json({ ...blocked(findings), error: "A habilidade tem instruções que o catálogo não aceita. Ajuste antes de publicar." }, 422) } as const;

		const index = await client.index().catch(() => null);
		const listed = index?.skills.find((entry) => entry.slug === doc.name) ?? null;
		const isUpdate = !!listed;
		if (listed && doc.source?.slug !== listed.slug) {
			return { response: c.json({ error: "Já existe uma habilidade com esse nome no catálogo. Renomeie a sua para publicar.", code: "name_taken" }, 409) } as const;
		}
		let previous: Awaited<ReturnType<CatalogClient["skill"]>> | null = null;
		if (listed) {
			previous = await client.skill(listed.slug).catch(() => null);
			if (!isNewerVersion(input.version, listed.version)) {
				return { response: c.json({ error: `A versão deve ser maior que a do catálogo (${listed.version}).`, code: "version" }, 422) } as const;
			}
		}
		const pkg = buildSkillPackage({ ...input, previousChangelog: previous?.manifest.changelog }, index);
		const diff = previous ? summarizeTextDiff(previous.skill.body, doc.body) : null;
		return { doc, pkg, index, isUpdate, diff, previousVersion: listed?.version ?? null, findings } as const;
	}

	/** Pacote para baixar (fallback): arquivos prontos para o PR. */
	app.post("/v1/skills/:id/package", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		try {
			const prepared = await preparePublish(c, userId);
			if ("response" in prepared) return prepared.response;
			return c.json({
				slug: prepared.pkg.slug,
				files: prepared.pkg.files.filter((file) => prepared.index || file.path !== "index.json"),
				newPrUrl: NEW_PR_URL,
				findings: prepared.findings,
			});
		} catch (error) {
			return failure(c, error);
		}
	});

	/**
	 * Publica no catálogo abrindo um PR com a conexão GitHub do próprio usuário.
	 * Sem conexão/permissão (ou sem índice para atualizar) devolve `mode: "package"`
	 * com os arquivos, para o web oferecer o download.
	 */
	app.post("/v1/skills/:id/publish", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		try {
			const prepared = await preparePublish(c, userId);
			if ("response" in prepared) return prepared.response;
			const { pkg, index, isUpdate, diff, previousVersion } = prepared;
			const fallback = (reason: string, message: string) =>
				c.json({
					mode: "package",
					reason,
					message,
					slug: pkg.slug,
					files: pkg.files,
					newPrUrl: NEW_PR_URL,
					findings: prepared.findings,
				});
			if (!index) return fallback("catalog_unavailable", "Não consegui ler o catálogo agora para montar o PR. Baixe o pacote e abra o PR pelo GitHub.");
			const github = await githubToken(userId).catch(() => null);
			if (!github) return fallback("github_not_connected", "Conecte o GitHub no marketplace para eu abrir o PR por você. Por enquanto, baixe o pacote.");
			const verb = isUpdate ? "Atualiza" : "Adiciona";
			const result = await openCatalogPullRequest(
				{
					token: github.token,
					login: github.login,
					pkg,
					title: `${verb} skill ${pkg.slug} ${pkg.manifest.version}`,
					body: pullRequestBody({ pkg, update: isUpdate, diff, previousVersion }),
				},
				deps.publish,
			);
			if (!result.ok) return fallback(result.reason, `${result.message} Baixe o pacote e abra o PR pelo GitHub.`);
			return c.json({ mode: "pr", url: result.url, number: result.number });
		} catch (error) {
			return failure(c, error);
		}
	});

	return app;
}
