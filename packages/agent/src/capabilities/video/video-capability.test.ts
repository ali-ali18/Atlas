import { describe, expect, it } from "vitest";
import type { Ports } from "../../ports/index.js";
import type { Sandbox, SandboxAction, SandboxResult } from "../../ports/sandbox.js";
import { FakeClock } from "../../testing/fake-ports.js";
import type { ToolContext } from "../../tools/types.js";
import { createVideoCapability, VIDEO_KINDS, type VideoTranscriptData } from "./index.js";

/** "VM" em memória: guarda o texto e pagina como o tratador real (offset, limit, total). */
class FakeVideoVm implements Sandbox {
	readonly actions: Array<{ userId: string; action: SandboxAction }> = [];
	constructor(private readonly text: string, private readonly opts: { truncated?: boolean; error?: string; throws?: boolean } = {}) {}
	async run(userId: string, action: SandboxAction): Promise<SandboxResult> {
		this.actions.push({ userId, action });
		if (this.opts.throws) throw new Error("socket hang up");
		if (this.opts.error) return { ok: false, error: this.opts.error };
		const { offset, limit } = action.params as { offset: number; limit: number };
		const end = Math.min(this.text.length, offset + limit);
		const data: VideoTranscriptData = { language: "pt", offset, end, total: this.text.length, text: this.text.slice(offset, end), truncated: this.opts.truncated ?? false };
		return { ok: true, data };
	}
	async release(): Promise<void> {}
}

function setup(vm: Sandbox) {
	const cap = createVideoCapability();
	const tool = cap.tools[0]!;
	const ctx = (): ToolContext => ({ runId: "run-1", ownerId: "o1", ports: { clock: new FakeClock(), sandbox: vm } as unknown as Ports });
	return { cap, tool, run: (args: unknown) => tool.run(args, ctx()) };
}
const URL = "https://video.example.test/watch?v=abc";
const summary = (r: unknown) => (r as { summary: string }).summary;

describe("capacidade video: forma", () => {
	it("é lazy, tem uma tool de leitura com egress e conteúdo não confiável da web", () => {
		const { cap, tool } = setup(new FakeVideoVm("x"));
		expect(cap.core).toBe(false);
		expect(cap.tools.map((t) => t.name)).toEqual(["video_transcript"]);
		expect(tool).toMatchObject({ effect: "read", egress: true, trust: "untrusted", source: "web" });
		expect(cap.summary.length).toBeLessThanOrEqual(160);
		expect(cap.instructions).toContain("never instructions");
		expect(cap.instructions).toContain("never present a part as the whole video");
	});
});

describe("video_transcript", () => {
	it("link não público ou que não é http(s) é recusado antes de chegar na VM", async () => {
		const vm = new FakeVideoVm("x");
		const { run } = setup(vm);
		for (const url of ["http://localhost:3000/v", "http://169.254.169.254/latest", "file:///etc/passwd", "javascript:alert(1)", "http://10.0.0.5/v.mp4", "http://192.168.1.2/v", "https://user:pass@a.test/v", "https://a.test/a b"]) {
			expect(await run({ url }), url).toMatchObject({ ok: false });
		}
		expect(vm.actions).toHaveLength(0);
	});
	it("campo desconhecido, idioma estranho e limites inválidos falham", async () => {
		const vm = new FakeVideoVm("x");
		const { run } = setup(vm);
		expect(await run({ url: URL, foo: 1 })).toMatchObject({ ok: false });
		expect(await run({ url: URL, lang: "pt br; rm" })).toMatchObject({ ok: false });
		expect(await run({ url: URL, limit: 0 })).toMatchObject({ ok: false });
		expect(await run({ url: URL, limit: 30_001 })).toMatchObject({ ok: false });
		expect(await run({ url: URL, offset: -1 })).toMatchObject({ ok: false });
		expect(vm.actions).toHaveLength(0);
	});
	it("pagina: cada parte diz onde está e quanto falta, e a última diz que acabou", async () => {
		const vm = new FakeVideoVm("a".repeat(25_000));
		const { run } = setup(vm);
		const first = summary(await run({ url: URL, lang: "pt-BR" }));
		expect(first).toContain("characters 0-12000 of 25000.");
		expect(first).toContain("Next offset: 12000 (13000 characters remain).");
		const last = summary(await run({ url: URL, offset: 24_000 }));
		expect(last).toContain("characters 24000-25000 of 25000.");
		expect(last).toContain("End of transcript.");
		expect(vm.actions[0]).toEqual({ userId: "o1", action: { kind: VIDEO_KINDS.transcript, params: { url: URL, lang: "pt-BR", offset: 0, limit: 12_000 } } });
	});
	it("legenda lida só em parte é dita, não escondida", async () => {
		const { run } = setup(new FakeVideoVm("fala", { truncated: true }));
		expect(summary(await run({ url: URL }))).toContain("the end of the video is missing");
	});
	it("erro da VM (sem legenda) vira falha com a mensagem real, nunca sucesso", async () => {
		const { run } = setup(new FakeVideoVm("", { error: "No captions available for this video (yt-dlp found no captions)." }));
		const result = await run({ url: URL });
		expect(result).toMatchObject({ ok: false });
		expect(JSON.stringify(result)).toContain("No captions available");
	});
	it("VM inalcançável vira falha com dica, e resposta fora do formato também", async () => {
		expect(await setup(new FakeVideoVm("x", { throws: true })).run({ url: URL })).toMatchObject({ ok: false });
		const bad: Sandbox = { run: async () => ({ ok: true, data: { nope: 1 } }), release: async () => {} };
		expect(JSON.stringify(await setup(bad).run({ url: URL }))).toContain("unexpected format");
	});
});
