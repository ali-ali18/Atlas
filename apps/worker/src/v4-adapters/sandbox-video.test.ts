/**
 * Tratador `video.transcript` do adaptador Sandbox com manager falso (sem Docker, yt-dlp nem rede): comando yt-dlp, fallback do
 * YouTube, cache por sessão, paginação, guarda de endereço privado e erro honesto. Também passa pelo despachante real
 * (`createV4Sandbox`) para provar o escopo por dono e a VM desligada.
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-adapters/sandbox-video.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { VIDEO_KINDS, type VideoTranscriptData } from "@workspace/agent";
import type { SandboxManager } from "@workspace/sandbox";
import { createV4Sandbox, type V4SandboxDeps } from "./sandbox.js";
import { createVideoTranscriptHandler } from "./sandbox-video.js";

const VTT = ["WEBVTT", "", "00:00:00.000 --> 00:00:02.000", "hoje vamos<00:00:00.500><c> falar</c>", "", "00:00:02.000 --> 00:00:04.000", "de energia solar", ""].join("\n");
const TEXT = "hoje vamos falar de energia solar";
const sh = (over: Record<string, unknown> = {}) => ({ background: false, exitCode: 0, stdout: "", stderr: "", durationMs: 10, timedOut: false, truncated: false, ...over });
const read = (content: string, nextOffset: number | null = null) => ({ path: "p", kind: "text" as const, size: content.length, content, totalLines: 1, nextOffset, truncated: nextOffset !== null });

type Calls = { shell: string[]; read: string[] };
function fakeManager(opts: { ytdlp?: ReturnType<typeof sh>; fallback?: ReturnType<typeof sh>; vtt?: string } = {}) {
	const calls: Calls = { shell: [], read: [] };
	const manager = {
		async execShell(_s: string, p: { command: string }) {
			calls.shell.push(p.command);
			if (p.command.includes("yt-dlp")) return opts.ytdlp ?? sh({ stdout: "sub.pt.vtt\n" });
			return opts.fallback ?? sh({ exitCode: 3, stderr: "NO_CAPTIONS" });
		},
		async execReadFile(_s: string, p: { path: string }) {
			calls.read.push(p.path);
			return read(opts.vtt ?? VTT);
		},
	};
	return { manager: manager as unknown as SandboxManager, calls };
}
const ctx = (manager: SandboxManager, sessionId = "s1") => ({ userId: "user-a", runId: "run-1", sessionId, manager });
const params = (over: Record<string, unknown> = {}) => ({ url: "https://video.example.test/watch?v=abc", offset: 0, limit: 12_000, ...over });

test("baixa a legenda, limpa o VTT e devolve a página com o total", async () => {
	const { manager, calls } = fakeManager();
	const handler = createVideoTranscriptHandler();
	const result = await handler(ctx(manager), params({ lang: "pt-BR" }));
	assert.equal(result.ok, true);
	const data = result.data as VideoTranscriptData;
	assert.deepEqual(data, { language: "pt", offset: 0, end: TEXT.length, total: TEXT.length, text: TEXT, truncated: false });
	assert.match(calls.shell[0]!, /yt-dlp .*--sub-langs 'pt-BR,pt-BR-orig,pt,pt-orig,en/);
	assert.match(calls.shell[0]!, /-- 'https:\/\/video\.example\.test\/watch\?v=abc'/);
});

test("pagina sem baixar de novo: a segunda parte sai do cache da sessão", async () => {
	const { manager, calls } = fakeManager();
	const handler = createVideoTranscriptHandler();
	const first = (await handler(ctx(manager), params({ limit: 10 }))).data as VideoTranscriptData;
	assert.equal(first.end, 10);
	assert.equal(first.total, TEXT.length);
	const second = (await handler(ctx(manager), params({ offset: 10, limit: 10 }))).data as VideoTranscriptData;
	assert.equal(second.text, TEXT.slice(10, 20));
	assert.equal(calls.shell.length, 1);
	const tailPage = (await handler(ctx(manager), params({ offset: 30, limit: 10 }))).data as VideoTranscriptData;
	assert.equal(tailPage.end, TEXT.length);
	const past = await handler(ctx(manager), params({ offset: TEXT.length }));
	assert.equal(past.ok, false);
	assert.match(past.error!, /past the end/);
});

test("o cache expira e é por sessão da VM (outra sessão baixa por conta própria)", async () => {
	const { manager, calls } = fakeManager();
	let t = 0;
	const handler = createVideoTranscriptHandler({ now: () => t });
	await handler(ctx(manager, "s1"), params());
	await handler(ctx(manager, "s2"), params());
	assert.equal(calls.shell.length, 2);
	t = 11 * 60_000;
	await handler(ctx(manager, "s1"), params());
	assert.equal(calls.shell.length, 3);
});

test("link privado, não http(s) ou com credencial é recusado sem tocar na VM", async () => {
	const { manager, calls } = fakeManager();
	const handler = createVideoTranscriptHandler();
	for (const url of ["http://localhost/v", "http://169.254.169.254/latest", "http://10.0.0.5/v", "file:///etc/passwd", "https://u:p@a.test/v"]) {
		const result = await handler(ctx(manager), params({ url }));
		assert.equal(result.ok, false, url);
	}
	assert.equal(calls.shell.length, 0);
});

test("parâmetro inválido falha com o motivo (limit zero, offset negativo, idioma estranho)", async () => {
	const { manager } = fakeManager();
	const handler = createVideoTranscriptHandler();
	for (const over of [{ limit: 0 }, { offset: -1 }, { lang: "pt; rm -rf /" }]) assert.equal((await handler(ctx(manager), params(over))).ok, false);
});

test("YouTube sem legenda no yt-dlp usa o fallback da página; fora do YouTube não há fallback", async () => {
	const fb = fakeManager({ ytdlp: sh({ exitCode: 1, stderr: "ERROR: no subtitles" }), fallback: sh({ stdout: "sub.en.vtt\n" }) });
	const ok = await createVideoTranscriptHandler()(ctx(fb.manager), params({ url: "https://www.youtube.com/watch?v=abc" }));
	assert.equal(ok.ok, true);
	assert.equal(fb.calls.shell.length, 2);
	assert.equal((ok.data as VideoTranscriptData).language, "en");

	const other = fakeManager({ ytdlp: sh({ exitCode: 1, stderr: "ERROR: unsupported" }) });
	const bad = await createVideoTranscriptHandler()(ctx(other.manager), params());
	assert.equal(bad.ok, false);
	assert.match(bad.error!, /No captions available/);
	assert.match(bad.error!, /not a YouTube link/);
	assert.equal(other.calls.shell.length, 1);
});

test("yt-dlp ausente na VM e legenda vazia dão erro honesto", async () => {
	const missing = await createVideoTranscriptHandler()(ctx(fakeManager({ ytdlp: sh({ exitCode: 127 }) }).manager), params());
	assert.equal(missing.ok, false);
	assert.match(missing.error!, /yt-dlp is not installed/);
	const empty = await createVideoTranscriptHandler()(ctx(fakeManager({ vtt: "WEBVTT\n" }).manager), params());
	assert.equal(empty.ok, false);
	assert.match(empty.error!, /empty after cleaning/);
});

test("segredo no texto da legenda é redigido antes de voltar", async () => {
	const vtt = ["WEBVTT", "", "00:00:00.000 --> 00:00:02.000", "a chave é ghp_abcdefghijklmnopqrstuvwxyz0123456789 ok", ""].join("\n");
	const result = await createVideoTranscriptHandler()(ctx(fakeManager({ vtt }).manager), params());
	assert.equal(result.ok, true);
	assert.ok(!(result.data as VideoTranscriptData).text.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
});

// Despachante real: escopo por dono e VM desligada.
function vmDeps(manager: SandboxManager): V4SandboxDeps {
	return { createManager: () => ({ ...(manager as object), resolveSession: async () => ({ sessionId: "s-user-a", status: "running", viewerUrl: "", createdAt: "" }), destroySession: async () => true }) as unknown as SandboxManager };
}

test("pelo despachante: roda na VM da conversa; outro dono é recusado e a VM desligada dá erro honesto", async () => {
	const { manager, calls } = fakeManager();
	const sandbox = createV4Sandbox({ scope: { userId: "user-a", runId: "run-1", conversationId: "conv-1" }, deps: vmDeps(manager), handlers: { [VIDEO_KINDS.transcript]: createVideoTranscriptHandler() } });
	const ok = await sandbox.run("user-a", { kind: VIDEO_KINDS.transcript, params: params() });
	assert.equal(ok.ok, true);
	const other = await sandbox.run("user-b", { kind: VIDEO_KINDS.transcript, params: params() });
	assert.equal(other.ok, false);
	assert.equal(calls.shell.length, 1);

	const off = createV4Sandbox({ scope: { userId: "user-a", runId: "run-1", conversationId: "conv-1" }, deps: null });
	const down = await off.run("user-a", { kind: VIDEO_KINDS.transcript, params: params() });
	assert.equal(down.ok, false);
	assert.match(down.error!, /could not be started/);
});

test("o despachante padrão já conhece o kind video.transcript", async () => {
	const { manager } = fakeManager();
	const sandbox = createV4Sandbox({ scope: { userId: "user-a", runId: "run-1", conversationId: "conv-1" }, deps: vmDeps(manager) });
	const result = await sandbox.run("user-a", { kind: VIDEO_KINDS.transcript, params: params() });
	assert.equal(result.ok, true);
});
