import {
	buildAttachmentHistoryNote,
	buildAttachmentTurnContext,
	createExtractCache,
	EXTRACT_CACHE_VERSION,
	type AttachmentRef,
	type AttachmentRuntime,
	type ExtractedAttachment,
	type ExtractStore,
	type Extractor,
} from "@workspace/agent-runtime";
import { loadArtifactForUser, loadUserFileHistory, loadUserFileMetas, readArtifactSidecar, writeArtifactSidecar, type UserFileMeta } from "@workspace/db";
import { supportsNativePdf } from "@workspace/shared";

type Deps = {
	loadHistory?: typeof loadUserFileHistory;
	loadMetas?: typeof loadUserFileMetas;
	loadArtifact?: typeof loadArtifactForUser;
	nativePdf?: (model: string) => boolean;
	/** Extrator (padrão: pool de worker threads com limites). */
	extractor?: Extractor;
	readSidecar?: typeof readArtifactSidecar;
	writeSidecar?: typeof writeArtifactSidecar;
};

const SIDECAR = "extract";

function validExtracted(value: unknown, ref: AttachmentRef): value is ExtractedAttachment {
	if (!value || typeof value !== "object") return false;
	const item = value as Partial<ExtractedAttachment>;
	return item.kind === ref.kind && typeof item.text === "string" && Array.isArray(item.tables) && Array.isArray(item.notes) && typeof item.textCut === "boolean";
}

/**
 * Cache em disco do texto extraído, ao lado do arquivo no storage (`<id>.<ext>.extract.json`).
 * O arquivo do usuário é imutável, então a chave é só a versão do formato. Só do dono.
 */
export function extractStoreFor(userId: string, deps: Pick<Deps, "readSidecar" | "writeSidecar"> = {}): ExtractStore {
	const read = deps.readSidecar ?? readArtifactSidecar;
	const write = deps.writeSidecar ?? writeArtifactSidecar;
	return {
		async read(ref) {
			const raw = await read(ref.id, userId, SIDECAR);
			if (!raw) return null;
			try {
				const parsed = JSON.parse(raw) as { v?: number; extracted?: unknown };
				return parsed.v === EXTRACT_CACHE_VERSION && validExtracted(parsed.extracted, ref) ? parsed.extracted : null;
			} catch {
				return null;
			}
		},
		async write(ref, extracted) {
			await write(ref.id, userId, SIDECAR, JSON.stringify({ v: EXTRACT_CACHE_VERSION, extracted }));
		},
	};
}

/**
 * Pré-extrai um anexo (job logo após o upload) para o primeiro run já encontrar o texto pronto.
 * Roda no pool do worker; nunca lança.
 */
export async function warmAttachmentExtract(input: { userId: string; artifactId: string; deps?: Deps }): Promise<"cached" | "extracted" | "skipped"> {
	const deps = input.deps ?? {};
	const loadMetas = deps.loadMetas ?? loadUserFileMetas;
	const loadArtifact = deps.loadArtifact ?? loadArtifactForUser;
	try {
		const [meta] = await loadMetas([input.artifactId], input.userId);
		if (!meta || meta.kind === "other" || meta.kind === "zip") return "skipped";
		const ref = toRef(meta);
		const store = extractStoreFor(input.userId, deps);
		if (await store.read(ref)) return "cached";
		const cache = createExtractCache(
			async (id) => {
				const artifact = await loadArtifact(id, input.userId).catch(() => null);
				return artifact && artifact.kind === "file" && artifact.meta.origin === "user" ? new Uint8Array(artifact.bytes) : null;
			},
			{ store, ...(deps.extractor ? { extractor: deps.extractor } : {}) },
		);
		return (await cache.get(ref)) ? "extracted" : "skipped";
	} catch {
		return "skipped";
	}
}

const toRef = (file: UserFileMeta): AttachmentRef => ({ id: file.artifactId, filename: file.filename, mime: file.mime, size: file.size, kind: file.kind });

/**
 * Anexos de arquivo do usuário para o run: lista (só do dono, desta conversa), conteúdo do pedido atual
 * (texto truncado ou PDF nativo, conforme o modelo) e leitor com cache. Nada é executado; falha ao
 * ler um arquivo vira aviso no contexto, nunca derruba o run. A leitura pesada (PDF/Office/planilha) roda
 * no pool de worker threads com limites de memória e tempo, e o resultado fica em cache ao lado do arquivo.
 */
export async function attachmentRuntimeForRun(input: {
	userId: string;
	conversationId: string | null;
	/** Arquivos do pedido inicial deste run (checkpoint). */
	currentIds: string[];
	/** Run novo (sem mensagens salvas): só ele monta o contexto do turno. */
	fresh: boolean;
	model: string;
	deps?: Deps;
}): Promise<{ runtime: AttachmentRuntime; historyNote: string | null }> {
	const loadHistory = input.deps?.loadHistory ?? loadUserFileHistory;
	const loadMetas = input.deps?.loadMetas ?? loadUserFileMetas;
	const loadArtifact = input.deps?.loadArtifact ?? loadArtifactForUser;
	const nativePdf = (input.deps?.nativePdf ?? supportsNativePdf)(input.model);
	const history = input.conversationId ? await loadHistory(input.conversationId, input.userId).catch(() => []) : [];
	const current = input.currentIds.length ? await loadMetas(input.currentIds, input.userId).catch(() => []) : [];

	const list = async (): Promise<AttachmentRef[]> => {
		const fresh = input.conversationId ? await loadHistory(input.conversationId, input.userId).catch(() => history) : history;
		const known = new Map(fresh.map((file) => [file.artifactId, file] as const));
		for (const file of current) if (!known.has(file.artifactId)) known.set(file.artifactId, file);
		return [...known.values()].map(toRef);
	};
	const allowed = async (id: string) => (await list()).find((ref) => ref.id === id);
	const load = async (id: string): Promise<Uint8Array | null> => {
		if (!(await allowed(id))) return null;
		const artifact = await loadArtifact(id, input.userId).catch(() => null);
		return artifact && artifact.kind === "file" && artifact.meta.origin === "user" ? new Uint8Array(artifact.bytes) : null;
	};
	const cache = createExtractCache(load, { store: extractStoreFor(input.userId, input.deps), ...(input.deps?.extractor ? { extractor: input.deps.extractor } : {}) });
	const present = history.length > 0 || current.length > 0;

	let turnContext: string | undefined;
	let nativePdfs: AttachmentRuntime["nativePdfs"];
	if (input.fresh && current.length) {
		const turn = await buildAttachmentTurnContext(current.map(toRef), { cache, nativePdf });
		turnContext = turn.text || undefined;
		nativePdfs = turn.nativePdfIds.map((id) => ({ id, filename: current.find((file) => file.artifactId === id)?.filename ?? "document.pdf" }));
	}
	const currentSet = new Set(current.map((file) => file.artifactId));
	const earlier = input.fresh ? history.filter((file) => !currentSet.has(file.artifactId)) : [];
	return {
		runtime: {
			present,
			...(turnContext ? { turnContext } : {}),
			...(nativePdfs?.length ? { nativePdfs } : {}),
			canReadNativePdf: nativePdf,
			list,
			cache,
			loadPdfDataUrl: async (id) => {
				const ref = await allowed(id);
				if (!ref || ref.kind !== "pdf") return null;
				const bytes = await load(id);
				return bytes ? `data:application/pdf;base64,${Buffer.from(bytes).toString("base64")}` : null;
			},
		},
		historyNote: buildAttachmentHistoryNote(earlier.map(toRef)),
	};
}
