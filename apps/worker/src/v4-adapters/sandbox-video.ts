// Ação `video.transcript` no despachante da porta `Sandbox`: baixa a legenda do vídeo DENTRO da VM da conversa (yt-dlp; no
// YouTube, se falhar, lê `captionTracks` da página), limpa o VTT (`parseVtt`) e devolve UMA página do texto. O contrato está em
// `@workspace/agent` (`capabilities/video/kinds.ts`). As peças puras (comandos, idiomas, paginação) vêm de `@workspace/shared`,
// as mesmas do motor antigo; aqui só se liga a VM. O dono é o da sessão já resolvida, nunca um parâmetro.
import { createHash } from "node:crypto";
import { VIDEO_KINDS, checkPublicHttpUrl, videoParams, type VideoTranscriptData } from "@workspace/agent";
import { SandboxShellError, type SandboxManager } from "@workspace/sandbox";
import { VIDEO_SUBTITLE_DIR, captionLanguages, captionTracksCommand, isYoutubeUrl, parseVtt, pickCaptionFile, redactSecrets, shq, sliceTranscript, ytDlpCommand } from "@workspace/shared";
import type { SandboxKindHandler } from "./sandbox.js";

const FETCH_TIMEOUT_S = 120;
/** Teto de pedaços do VTT lidos da VM (~38 KB cada): vídeos de várias horas viram texto cortado, com aviso. */
const MAX_READ_PAGES = 40;
const READ_PAGE_LINES = 2000;
const CHUNK_BYTES = 38_000;
const CACHE_MAX = 8;
const CACHE_TTL_MS = 10 * 60_000;

type CacheEntry = { text: string; language: string; truncated: boolean; at: number };

export type VideoTranscriptDeps = { now?: () => number };

function tail(text: string, max = 300): string {
	const t = text.trim();
	return redactSecrets(t.length > max ? `…${t.slice(t.length - max)}` : t);
}

/** Lê o VTT da VM; arquivo grande é fatiado UMA vez na VM em pedaços de linhas inteiras (`split -C`) e cada pedaço é lido uma vez. */
async function readVtt(manager: SandboxManager, sessionId: string, path: string): Promise<{ vtt: string; truncated: boolean }> {
	const first = await manager.execReadFile(sessionId, { path, offset: 0, limit: READ_PAGE_LINES });
	if (first.nextOffset === null || first.nextOffset === undefined) return { vtt: first.content, truncated: false };
	const prefix = `${path}.chunk.`;
	const run = await manager.execShell(sessionId, {
		command: [`rm -f ${shq(prefix)}*`, `split -C ${CHUNK_BYTES} -d -a 3 -- ${shq(path)} ${shq(prefix)} || exit 2`, `ls -1 ${shq(prefix)}* | head -n ${MAX_READ_PAGES + 1}`].join("\n"),
		timeoutS: 60,
		background: false,
	});
	const chunks = run.stdout.split("\n").map((l) => l.trim()).filter(Boolean).sort();
	if (chunks.length === 0) throw new Error(`Could not split the caption file for reading (${tail(run.stderr) || `exit ${run.exitCode}`}).`);
	let truncated = chunks.length > MAX_READ_PAGES;
	let vtt = "";
	for (const chunk of chunks.slice(0, MAX_READ_PAGES)) {
		const part = await manager.execReadFile(sessionId, { path: chunk, offset: 0, limit: 10_000 });
		vtt += `${part.content}\n`;
		if (part.nextOffset !== null && part.nextOffset !== undefined) truncated = true;
	}
	return { vtt, truncated };
}

async function fetchTranscript(manager: SandboxManager, sessionId: string, url: string, lang: string | undefined, key: string): Promise<Omit<CacheEntry, "at">> {
	const languages = captionLanguages(lang);
	const dir = `${VIDEO_SUBTITLE_DIR}/${key}`;
	let files: string[] = [];
	let note = "";
	try {
		const run = await manager.execShell(sessionId, { command: ytDlpCommand(dir, url, languages), timeoutS: FETCH_TIMEOUT_S, background: false });
		files = run.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
		if (files.length === 0) note = run.exitCode === 127 ? "yt-dlp is not installed on this VM" : `yt-dlp found no captions${run.stderr.trim() ? ` (${tail(run.stderr)})` : ""}`;
		if (run.timedOut) note = "yt-dlp timed out";
	} catch (error) {
		if (!(error instanceof SandboxShellError)) throw error;
		note = `yt-dlp could not run (${tail(error.message)})`;
	}
	let usedFallback = false;
	if (files.length === 0 && isYoutubeUrl(url)) {
		usedFallback = true;
		try {
			const run = await manager.execShell(sessionId, { command: captionTracksCommand(dir, url, languages), timeoutS: FETCH_TIMEOUT_S, background: false });
			files = run.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
			if (files.length === 0) note += `; page captions: ${run.stderr.includes("NO_CAPTIONS") ? "the video has no caption tracks" : tail(run.stderr) || "nothing returned"}`;
		} catch (error) {
			if (!(error instanceof SandboxShellError)) throw error;
			note += `; page captions failed (${tail(error.message)})`;
		}
	}
	const file = pickCaptionFile(files, languages);
	if (!file) {
		throw new Error(`No captions available for this video (${note || "none found"}${usedFallback ? "" : "; not a YouTube link, so no page fallback"}). Tell the owner the video has no readable captions, and offer to read its description or comments from the page instead.`);
	}
	const { vtt, truncated } = await readVtt(manager, sessionId, `${dir}/${file}`);
	const parsed = parseVtt(vtt);
	if (!parsed.text) throw new Error("The caption file was empty after cleaning. Tell the owner the video has no readable captions, and offer to read its description or comments from the page instead.");
	return { text: parsed.text, language: file.replace(/^sub\./, "").replace(/\.vtt$/, ""), truncated };
}

/** O cache vive no tratador (um por processo) e é chaveado por sessão da VM: usuário B nunca lê o texto baixado na VM de A. */
export function createVideoTranscriptHandler(deps: VideoTranscriptDeps = {}): SandboxKindHandler {
	const now = deps.now ?? Date.now;
	const cache = new Map<string, CacheEntry>();
	return async (ctx, rawParams) => {
		const parsed = videoParams.transcript.safeParse(rawParams);
		if (!parsed.success) return { ok: false, error: `Invalid video request (${parsed.error.issues[0]?.path.join(".") || "root"}: ${parsed.error.issues[0]?.message ?? "invalid"}).` };
		const params = parsed.data;
		// A fronteira não confia em quem chama: o link é aberto de DENTRO da VM, então repete a guarda de endereço público.
		const check = checkPublicHttpUrl(params.url);
		if (!check.ok) return { ok: false, error: `The video link was refused (${check.reason}). Give the public http(s) link of the video.` };
		const url = check.url.toString();
		const key = createHash("sha256").update(`${url}\n${captionLanguages(params.lang).join(",")}`).digest("hex").slice(0, 24);
		const cacheKey = `${ctx.sessionId}:${key}`;
		try {
			let entry = cache.get(cacheKey);
			if (entry && now() - entry.at > CACHE_TTL_MS) {
				cache.delete(cacheKey);
				entry = undefined;
			}
			if (!entry) {
				const fetched = await fetchTranscript(ctx.manager, ctx.sessionId, url, params.lang, key);
				entry = { ...fetched, at: now() };
				cache.set(cacheKey, entry);
				while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
			}
			const page = sliceTranscript(entry.text, params.offset, params.limit);
			const data: VideoTranscriptData = { language: entry.language, offset: page.offset, end: page.end, total: page.total, text: redactSecrets(page.text), truncated: entry.truncated };
			return { ok: true, data };
		} catch (error) {
			return { ok: false, error: redactSecrets(error instanceof Error ? error.message : String(error)) };
		}
	};
}

export const videoKindHandlers: Readonly<Record<string, SandboxKindHandler>> = { [VIDEO_KINDS.transcript]: createVideoTranscriptHandler() };
