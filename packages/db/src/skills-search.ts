import { embedText } from "@workspace/llm";
import { prisma } from "./client.js";

export type SkillEmbeddingRecipe = {
	title: string;
	description: string;
	triggers: string[];
};

export type SkillSearchInput = {
	userId: string;
	botId: string;
	query: string;
	limit?: number;
};

export type SkillSearchHit = {
	versionId: string;
	skillId: string;
	capabilityKey: string;
	title: string;
	number: number;
	content: unknown;
	score: number;
	via: "vector" | "text" | "both";
};

const RRF_K = 60;
const VECTOR_BRANCH_LIMIT = 10;
const LEXICAL_BRANCH_LIMIT = 10;

export function skillEmbeddingText(recipe: SkillEmbeddingRecipe): string {
	return `Skill search: ${recipe.title}. ${recipe.description}. Gatilhos: ${recipe.triggers.join("; ")}`.slice(0, 1000);
}

function embeddingApiKey(): string | null {
	const key = process.env.OPENROUTER_API_KEY?.trim();
	return key && key.length > 0 ? key : null;
}

/** Gera embedding ou null (sem key/falha = sem vetor, sem quebrar). */
export async function tryEmbedSkill(text: string): Promise<number[] | null> {
	const apiKey = embeddingApiKey();
	if (!apiKey) return null;
	try {
		const result = await embedText({ text, apiKey });
		if (!result.embedding.every(Number.isFinite)) return null;
		return result.embedding;
	} catch (error) {
		console.warn(
			"skill search embedding failed; continuing without vector",
			error instanceof Error ? error.message : error,
		);
		return null;
	}
}

function vectorLiteral(vector: number[]): string {
	return `[${vector.join(",")}]`;
}

export async function storeSkillVersionEmbedding(
	versionId: string,
	vector: number[],
): Promise<void> {
	await prisma.$executeRaw`UPDATE skill_versions SET embedding = ${vectorLiteral(vector)}::vector WHERE id = ${versionId}`;
}

function contentRecord(content: unknown): Record<string, unknown> {
	if (content && typeof content === "object" && !Array.isArray(content)) {
		return content as Record<string, unknown>;
	}
	return {};
}

function contentTitle(content: unknown, fallback: string): string {
	const record = contentRecord(content);
	const title = record["title"];
	if (typeof title === "string" && title.trim().length > 0) return title.trim();
	return fallback;
}

function contentDescription(content: unknown): string {
	const record = contentRecord(content);
	const description = record["description"];
	return typeof description === "string" ? description : "";
}

function contentTriggers(content: unknown): string[] {
	const record = contentRecord(content);
	const triggers = record["triggers"];
	if (!Array.isArray(triggers)) return [];
	return triggers
		.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		.map((item) => item.trim());
}

/** Re-gera o embedding da versão escopada (best effort, nunca explode). */
export async function refreshSkillVersionEmbedding(
	userId: string,
	botId: string,
	versionId: string,
): Promise<boolean> {
	try {
		const version = await prisma.skillVersion.findFirst({
			where: { id: versionId, skill: { is: { userId, botId } } },
			include: { skill: true },
		});
		if (!version) return false;
		const title = contentTitle(version.content, version.skill.capabilityKey);
		const text = skillEmbeddingText({
			title,
			description: contentDescription(version.content),
			triggers: contentTriggers(version.content),
		});
		const vector = await tryEmbedSkill(text);
		if (!vector) return false;
		await storeSkillVersionEmbedding(version.id, vector);
		return true;
	} catch (error) {
		console.warn(
			"refresh skill version embedding failed",
			error instanceof Error ? error.message : error,
		);
		return false;
	}
}

function tokenize(text: string): string[] {
	const stop = new Set([
		"para", "com", "esse", "essa", "este", "esta", "uma", "isso", "disso",
		"mas", "que", "nao", "sim", "como", "muito", "mais", "foi", "sao",
		"tem", "ser", "ter", "dos", "das", "nos", "nas", "por", "ela", "ele",
		"the", "and", "for", "with", "are", "was",
	]);
	return text
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((term) => term.length > 2 && !stop.has(term));
}

async function vectorBranch(input: {
	userId: string;
	botId: string;
	embedding: number[];
}): Promise<string[]> {
	const literal = vectorLiteral(input.embedding);
	const rows = await prisma.$queryRaw<Array<{ id: string }>>`SELECT v."id" AS id
		FROM "skill_versions" v
		JOIN "skills" s ON s."id" = v."skillId"
		WHERE s."userId" = ${input.userId} AND s."botId" = ${input.botId} AND s."enabled" = true
			AND v."id" = s."activeVersionId"
			AND v."revokedAt" IS NULL
			AND v."embedding" IS NOT NULL
		ORDER BY v."embedding" <=> ${literal}::vector
		LIMIT ${VECTOR_BRANCH_LIMIT}`;
	return rows.map((row) => row.id);
}

type LexicalCandidate = { id: string; score: number };

async function lexicalBranch(input: {
	userId: string;
	botId: string;
	query: string;
}): Promise<LexicalCandidate[]> {
	const queryTerms = new Set(tokenize(input.query));
	if (queryTerms.size === 0) return [];
	const skills = await prisma.skill.findMany({
		where: { userId: input.userId, botId: input.botId, enabled: true },
		include: { versions: true },
	});
	const candidates: LexicalCandidate[] = [];
	for (const skill of skills) {
		if (!skill.activeVersionId) continue;
		const version = skill.versions.find((item) => item.id === skill.activeVersionId);
		if (!version || version.revokedAt) continue;
		const haystack = [
			skill.capabilityKey.replace(/[-_]+/g, " "),
			contentTitle(version.content, ""),
			contentDescription(version.content),
			contentTriggers(version.content).join(" "),
		].join(" ");
		const hayTerms = new Set(tokenize(haystack));
		let matched = 0;
		for (const term of queryTerms) {
			if (hayTerms.has(term)) matched += 1;
		}
		const score = matched / queryTerms.size;
		if (score > 0) candidates.push({ id: version.id, score });
	}
	return candidates
		.sort((a, b) => b.score - a.score)
		.slice(0, LEXICAL_BRANCH_LIMIT);
}

/** Busca híbrida de skills ativas (vetor + léxica, fusão RRF). */
export async function searchSkillVersions(
	input: SkillSearchInput,
): Promise<SkillSearchHit[]> {
	const query = input.query.trim();
	const limit = input.limit ?? 5;
	if (!query) return [];

	const embedding = await tryEmbedSkill(query);
	const scores = new Map<string, { score: number; via: Set<string> }>();
	const bump = (id: string, rank: number, via: string) => {
		const current = scores.get(id) ?? { score: 0, via: new Set<string>() };
		current.score += 1 / (RRF_K + rank);
		current.via.add(via);
		scores.set(id, current);
	};

	if (embedding) {
		const ids = await vectorBranch({
			userId: input.userId,
			botId: input.botId,
			embedding,
		});
		ids.forEach((id, index) => bump(id, index + 1, "vector"));
	}
	const lexical = await lexicalBranch({
		userId: input.userId,
		botId: input.botId,
		query,
	});
	lexical.forEach((candidate, index) => bump(candidate.id, index + 1, "text"));

	// Fallback substring: query curta ("pesquisa") acha capabilityKey/título
	// mesmo sem overlap de termos e sem vetor.
	if (scores.size === 0 && query.length >= 4) {
		const like = `%${query.slice(0, 60)}%`;
		const rows = await prisma.$queryRaw<Array<{ id: string }>>`SELECT v."id" AS id
			FROM "skill_versions" v
			JOIN "skills" s ON s."id" = v."skillId"
			WHERE s."userId" = ${input.userId} AND s."botId" = ${input.botId} AND s."enabled" = true
				AND v."id" = s."activeVersionId" AND v."revokedAt" IS NULL
				AND (s."capabilityKey" ILIKE ${like} OR v."content"->>'title' ILIKE ${like})
			LIMIT ${LEXICAL_BRANCH_LIMIT}`;
		rows.forEach((row, index) => bump(row.id, index + 1, "text"));
	}

	if (scores.size === 0) return [];
	const ranked = [...scores.entries()]
		.sort((a, b) => b[1].score - a[1].score)
		.slice(0, limit);

	const rows = await prisma.skillVersion.findMany({
		where: { id: { in: ranked.map(([id]) => id) } },
		include: { skill: true },
	});
	const byId = new Map(rows.map((row) => [row.id, row]));
	const hits: SkillSearchHit[] = [];
	for (const [id, meta] of ranked) {
		const row = byId.get(id);
		if (!row) continue;
		hits.push({
			versionId: row.id,
			skillId: row.skillId,
			capabilityKey: row.skill.capabilityKey,
			title: contentTitle(row.content, row.skill.capabilityKey),
			number: row.number,
			content: row.content as unknown,
			score: meta.score,
			via: (meta.via.has("vector") && meta.via.has("text")
				? "both"
				: meta.via.has("vector")
					? "vector"
					: "text") as SkillSearchHit["via"],
		});
	}
	return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
