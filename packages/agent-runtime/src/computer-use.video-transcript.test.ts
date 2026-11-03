import { beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxShellError, type SandboxManager } from "@workspace/sandbox";
import type { CompleteChatWithToolsResult, LlmToolCall } from "@workspace/llm";
import { COMPUTER_USE_TOOLS, runComputerUse } from "./computer-use.js";
import { GROUP_COMPANIONS, NATIVE_TOOL_GROUPS } from "./context/native-tools.js";
import { isSandboxTool } from "./tools/registry/sandbox-tools.js";
import {
	VIDEO_TRANSCRIPT_TOOL,
	captionLanguages,
	clearVideoTranscriptCache,
	executeVideoTranscript,
	parseVideoTranscriptArgs,
	pickCaptionFile,
	videoTranscriptBlocked,
} from "./tools/video-transcript.js";

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => null),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
}));

const policy = { level: "balanced" as const, exceptions: [] };
const sh = (over = {}) => ({ background: false, exitCode: 0, stdout: "", stderr: "", durationMs: 10, timedOut: false, truncated: false, ...over });
const VTT = [
	"WEBVTT",
	"Kind: captions",
	"",
	"00:00:00.000 --> 00:00:02.000",
	"hoje vamos<00:00:00.500><c> falar</c>",
	"",
	"00:00:02.000 --> 00:00:04.000",
	"hoje vamos falar",
	"de energia solar",
	"",
	"00:00:04.000 --> 00:00:04.010",
	"de energia solar",
	"",
].join("\n");
const read = (content: string, nextOffset: number | null = null) => ({ path: "p", kind: "text" as const, size: content.length, content, totalLines: 1, nextOffset, truncated: nextOffset !== null });
const asManager = (m: Record<string, unknown>) => m as unknown as SandboxManager;
const ctx = (m: Record<string, unknown>) => ({ manager: asManager(m), getSessionId: async () => "s1" });

beforeEach(() => clearVideoTranscriptCache());

describe("video_transcript: args", () => {
	it("aceita http(s) e normaliza; limita offset/limit", () => {
		const a = parseVideoTranscriptArgs({ url: " https://youtu.be/xyz ", lang: "pt-BR", offset: 5, limit: 999999 });
		expect(a).toEqual({ url: "https://youtu.be/xyz", lang: "pt-BR", offset: 5, limit: 30_000 });
	});
	it("rejeita url vazia, esquema não http, espaço, controle, tamanho e lang estranho", () => {
		expect(() => parseVideoTranscriptArgs({})).toThrow("url is required");
		expect(() => parseVideoTranscriptArgs({ url: "file:///etc/passwd" })).toThrow("http");
		expect(() => parseVideoTranscriptArgs({ url: "javascript:alert(1)" })).toThrow("http");
		expect(() => parseVideoTranscriptArgs({ url: "https://a.test/x y" })).toThrow("spaces");
		expect(() => parseVideoTranscriptArgs({ url: "https://a.test/\u0000" })).toThrow("control");
		expect(() => parseVideoTranscriptArgs({ url: `https://a.test/${"a".repeat(3000)}` })).toThrow("too long");
		expect(() => parseVideoTranscriptArgs({ url: "https://a.test/v", lang: "pt; rm -rf /" })).toThrow("lang");
		expect(() => parseVideoTranscriptArgs({ url: "https://a.test/v", offset: -1 })).toThrow("offset");
	});
	it("rejeita host interno: localhost, loopback, rede privada, link-local e metadata", () => {
		for (const url of [
			"http://localhost/v",
			"http://app.localhost/v",
			"http://127.0.0.1/v",
			"http://10.0.0.5/v",
			"http://192.168.1.1/v",
			"http://172.16.0.1/v",
			"http://169.254.169.254/latest/meta-data",
			"http://[::1]/v",
			"http://[fe80::1]/v",
			"http://metadata.google.internal/v",
		]) {
			expect(() => parseVideoTranscriptArgs({ url }), url).toThrow("internal address");
		}
		expect(parseVideoTranscriptArgs({ url: "https://8.8.8.8/v" }).url).toBe("https://8.8.8.8/v");
	});
	it("lang precisa começar por letra (hífen no início viraria exclusão no --sub-langs)", () => {
		expect(() => parseVideoTranscriptArgs({ url: "https://a.test/v", lang: "-en" })).toThrow("lang");
		expect(() => parseVideoTranscriptArgs({ url: "https://a.test/v", lang: "_en" })).toThrow("lang");
		expect(() => parseVideoTranscriptArgs({ url: "https://a.test/v", lang: "1en" })).toThrow("lang");
		expect(parseVideoTranscriptArgs({ url: "https://a.test/v", lang: "pt-BR" }).lang).toBe("pt-BR");
	});
	it("idiomas: o pedido vem primeiro, depois o original e en/pt/es; escolhe o arquivo pela ordem", () => {
		expect(captionLanguages("pt-BR").slice(0, 4)).toEqual(["pt-BR", "pt-BR-orig", "pt", "pt-orig"]);
		expect(captionLanguages(undefined)[0]).toBe("en");
		expect(pickCaptionFile(["sub.en.vtt", "sub.pt.vtt"], captionLanguages("pt"))).toBe("sub.pt.vtt");
		expect(pickCaptionFile(["sub.fr.vtt", "sub.en.vtt"], captionLanguages(undefined))).toBe("sub.en.vtt");
		expect(pickCaptionFile([], ["en"])).toBeUndefined();
	});
});

describe("video_transcript: executor", () => {
	it("yt-dlp com sucesso: lê o VTT, limpa e devolve com aviso de não confiável", async () => {
		const execShell = vi.fn(async () => sh({ stdout: "sub.en.vtt\n" }));
		const execReadFile = vi.fn(async () => read(VTT));
		const out = await executeVideoTranscript({ url: "https://youtu.be/xyz" }, ctx({ execShell, execReadFile }));
		expect(execShell).toHaveBeenCalledTimes(1);
		const command = (execShell.mock.calls[0] as unknown as [string, { command: string }])[1].command;
		expect(command).toContain("yt-dlp --no-playlist --skip-download --write-subs --write-auto-subs");
		expect(command).toContain("'https://youtu.be/xyz'");
		expect(out.summary).toContain("language: en");
		expect(out.summary).toContain("hoje vamos falar de energia solar");
		expect(out.summary).toContain("End of transcript");
		expect(out.summary.toLowerCase()).toContain("untrusted");
	});

	it("pagina por caracteres e reaproveita o texto sem baixar de novo", async () => {
		const execShell = vi.fn(async () => sh({ stdout: "sub.en.vtt\n" }));
		const execReadFile = vi.fn(async () => read(VTT));
		const first = await executeVideoTranscript({ url: "https://youtu.be/xyz", limit: 10 }, ctx({ execShell, execReadFile }));
		expect(first.summary).toContain("characters 0-10 of 33");
		expect(first.summary).toContain("Next offset: 10");
		const second = await executeVideoTranscript({ url: "https://youtu.be/xyz", offset: 10, limit: 100 }, ctx({ execShell, execReadFile }));
		expect(second.summary).toContain("End of transcript");
		expect(execShell).toHaveBeenCalledTimes(1);
		await expect(executeVideoTranscript({ url: "https://youtu.be/xyz", offset: 500 }, ctx({ execShell, execReadFile }))).rejects.toThrow("past the end");
	});

	it("VTT grande: fatia uma vez na VM em linhas inteiras e lê cada pedaço uma só vez, sem texto duplicado ou cortado", async () => {
		// A 1ª leitura (paginada) devolve a última linha cortada no meio ("segun") com nextOffset nela: era isso que duplicava texto.
		const execShell = vi
			.fn()
			.mockResolvedValueOnce(sh({ stdout: "sub.pt.vtt\n" }))
			.mockResolvedValueOnce(sh({ stdout: "/home/atlas/work/.transcripts/k/sub.pt.vtt.chunk.001\n/home/atlas/work/.transcripts/k/sub.pt.vtt.chunk.000\n" }));
		const execReadFile = vi.fn(async (_s: string, p: { path: string; offset?: number }) => {
			if (p.path.endsWith("sub.pt.vtt")) return read("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nprimeira\n\n00:00:01.000 --> 00:00:02.000\nsegun", 5);
			if (p.path.endsWith("chunk.000")) return read("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nprimeira\n");
			return read("\n00:00:01.000 --> 00:00:02.000\nsegunda\n");
		});
		const out = await executeVideoTranscript({ url: "https://youtu.be/xyz", lang: "pt" }, ctx({ execShell, execReadFile }));
		const split = (execShell.mock.calls[1] as unknown as [string, { command: string }])[1].command;
		expect(split).toContain("split -C 38000");
		expect(execReadFile).toHaveBeenCalledTimes(3);
		expect(out.summary).toContain("primeira segunda");
		expect(out.summary).not.toContain("segun segunda");
		expect(out.summary).not.toContain("truncated");
	});

	it("VTT com mais pedaços que o teto: avisa que o fim do vídeo ficou de fora", async () => {
		const chunks = Array.from({ length: 41 }, (_, i) => `/d/c.${String(i).padStart(3, "0")}`).join("\n");
		const execShell = vi.fn().mockResolvedValueOnce(sh({ stdout: "sub.en.vtt\n" })).mockResolvedValueOnce(sh({ stdout: `${chunks}\n` }));
		const execReadFile = vi.fn(async (_s: string, p: { path: string }) =>
			p.path.endsWith(".vtt") ? read("WEBVTT\n", 5) : read("00:00:00.000 --> 00:00:01.000\nfala\n"),
		);
		const out = await executeVideoTranscript({ url: "https://youtu.be/xyz" }, ctx({ execShell, execReadFile }));
		expect(out.summary).toContain("end of the video is missing");
		expect(execReadFile).toHaveBeenCalledTimes(1 + 40);
	});

	it("yt-dlp sem legenda no YouTube: cai para captionTracks da página", async () => {
		const execShell = vi
			.fn()
			.mockResolvedValueOnce(sh({ exitCode: 0, stdout: "", stderr: "There are no subtitles" }))
			.mockResolvedValueOnce(sh({ stdout: "sub.en.vtt\n" }));
		const execReadFile = vi.fn(async () => read(VTT));
		const out = await executeVideoTranscript({ url: "https://www.youtube.com/watch?v=abc" }, ctx({ execShell, execReadFile }));
		expect(execShell).toHaveBeenCalledTimes(2);
		const fallback = (execShell.mock.calls[1] as unknown as [string, { command: string }])[1].command;
		expect(fallback).toContain("captionTracks");
		expect(fallback).toContain("VT_URL='https://www.youtube.com/watch?v=abc'");
		expect(out.summary).toContain("energia solar");
	});

	it("yt-dlp ausente na imagem também usa o fallback", async () => {
		const execShell = vi
			.fn()
			.mockResolvedValueOnce(sh({ exitCode: 127, stderr: "yt-dlp: command not found" }))
			.mockResolvedValueOnce(sh({ stdout: "sub.en.vtt\n" }));
		const out = await executeVideoTranscript({ url: "https://youtu.be/abc" }, ctx({ execShell, execReadFile: vi.fn(async () => read(VTT)) }));
		expect(out.summary).toContain("energia solar");
	});

	it("sem legenda em nenhum caminho: erro honesto com dica", async () => {
		const execShell = vi
			.fn()
			.mockResolvedValueOnce(sh({ stdout: "" }))
			.mockResolvedValueOnce(sh({ exitCode: 3, stderr: "NO_CAPTIONS" }));
		const p = executeVideoTranscript({ url: "https://youtu.be/abc" }, ctx({ execShell }));
		await expect(p).rejects.toThrow("No captions available");
		await expect(executeVideoTranscript({ url: "https://youtu.be/abc" }, ctx({ execShell: vi.fn().mockResolvedValue(sh()) }))).rejects.toThrow("description or comments");
	});

	it("fora do YouTube não há fallback; VTT que fica vazio depois da limpeza também falha", async () => {
		const execShell = vi.fn(async () => sh({ stdout: "" }));
		await expect(executeVideoTranscript({ url: "https://vimeo.com/1" }, ctx({ execShell }))).rejects.toThrow("not a YouTube link");
		expect(execShell).toHaveBeenCalledTimes(1);
		const empty = vi.fn(async () => sh({ stdout: "sub.en.vtt\n" }));
		await expect(executeVideoTranscript({ url: "https://vimeo.com/2" }, ctx({ execShell: empty, execReadFile: vi.fn(async () => read("WEBVTT\n")) }))).rejects.toThrow("empty after cleaning");
	});

	it("falha de shell esperada vira 'sem legenda' (não sucesso); erro de infraestrutura propaga", async () => {
		const shellError = vi.fn(async () => {
			throw new SandboxShellError("comando expirou");
		});
		await expect(executeVideoTranscript({ url: "https://vimeo.com/3" }, ctx({ execShell: shellError }))).rejects.toThrow("No captions available");
		const infra = vi.fn(async () => {
			throw new Error("Sandbox session not found: s1");
		});
		await expect(executeVideoTranscript({ url: "https://vimeo.com/4" }, ctx({ execShell: infra }))).rejects.toThrow("not found");
	});

	it("url inválida falha antes de tocar na VM", async () => {
		const execShell = vi.fn();
		await expect(executeVideoTranscript({ url: "ftp://x.test/v" }, ctx({ execShell }))).rejects.toThrow("http");
		expect(execShell).not.toHaveBeenCalled();
	});

	it("aspas na url não escapam do comando", async () => {
		const execShell = vi.fn(async () => sh({ stdout: "sub.en.vtt\n" }));
		await executeVideoTranscript({ url: "https://a.test/v?x=1'$(id)'" }, ctx({ execShell, execReadFile: vi.fn(async () => read(VTT)) }));
		const command = (execShell.mock.calls[0] as unknown as [string, { command: string }])[1].command;
		// A URL normalizada já escapa a aspa (%27); o comando nunca a fecha dentro da string.
		expect(command).toContain("-- 'https://a.test/v?x=1%27$(id)%27'");
	});
});

describe("video_transcript: catálogo e exposição", () => {
	const call = (id: string, name: string, args: Record<string, unknown>): LlmToolCall => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
	const done: CompleteChatWithToolsResult = { model: "m", message: { role: "assistant", content: "Finished." } };

	it("está no catálogo, no grupo do navegador (lazy) e conta como tool da VM", () => {
		expect(COMPUTER_USE_TOOLS.some((t) => t.function.name === "video_transcript")).toBe(true);
		expect(NATIVE_TOOL_GROUPS.video.tools).toEqual(["video_transcript"]);
		expect(GROUP_COMPANIONS.browser).toContain("video");
		expect(isSandboxTool("video_transcript")).toBe(true);
		const description = VIDEO_TRANSCRIPT_TOOL.function.description!;
		expect(description).toContain("USE when");
		expect(description).toContain("Do NOT use");
		expect(description.length).toBeLessThan(900);
	});

	it("exceção bloqueada tira a tool", () => {
		expect(videoTranscriptBlocked(policy)).toBe(false);
		expect(videoTranscriptBlocked({ ...policy, exceptions: [{ tool: "video_transcript", mode: "blocked" }] })).toBe(true);
	});

	async function firstCallTools(text: string, extra: Record<string, unknown> = {}) {
		let names: string[] = [];
		await runComputerUse({
			manager: {} as SandboxManager,
			getSessionId: async () => "unused",
			sandboxEnabled: true,
			apiKey: "test",
			model: "m",
			runId: "run-video-tools",
			userId: "user-a",
			origin: "chat",
			autonomy: policy,
			messages: [{ role: "user" as const, content: text }],
			onEvent: () => undefined,
			streamChat: async (params) => {
				names = (params.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name);
				return done;
			},
			...extra,
		} as Parameters<typeof runComputerUse>[0]);
		return names;
	}

	it("pedido com link do vídeo já traz a tool; 'Bom dia' não; sem sandbox nunca", async () => {
		expect(await firstCallTools("resume este vídeo https://youtu.be/xyz")).toContain("video_transcript");
		expect(await firstCallTools("Bom dia")).not.toContain("video_transcript");
		expect(await firstCallTools("Bom dia", { sandboxEnabled: false })).not.toContain("video_transcript");
		expect(await firstCallTools("resume este vídeo https://youtu.be/xyz", { sandboxEnabled: false })).not.toContain("video_transcript");
	});

	it("replay: 'resume este vídeo' -> o modelo chama video_transcript -> responde com o conteúdo", async () => {
		const execShell = vi.fn(async () => sh({ stdout: "sub.en.vtt\n" }));
		const execReadFile = vi.fn(async () => read(VTT));
		let step = 0;
		const seen: string[] = [];
		const events: Array<{ type: string }> = [];
		await runComputerUse({
			manager: asManager({ execShell, execReadFile }),
			getSessionId: async () => "s1",
			sandboxEnabled: true,
			apiKey: "test",
			model: "m",
			runId: "run-video-replay",
			userId: "user-a",
			origin: "chat",
			autonomy: policy,
			messages: [{ role: "user" as const, content: "resume este vídeo https://youtu.be/xyz" }],
			onEvent: (event) => events.push(event as { type: string }),
			streamChat: async (params) => {
				seen.push(JSON.stringify(params.messages));
				return step++ === 0
					? { model: "m", message: { role: "assistant", content: null, tool_calls: [call("t1", "video_transcript", { url: "https://youtu.be/xyz" })] } }
					: { model: "m", message: { role: "assistant", content: "O vídeo fala de energia solar." } };
			},
		} as Parameters<typeof runComputerUse>[0]);
		expect(execShell).toHaveBeenCalledTimes(1);
		expect(seen[1]).toContain("hoje vamos falar de energia solar");
		expect(seen[1]).toContain("untrusted");
		expect(step).toBe(2);
	});
});
