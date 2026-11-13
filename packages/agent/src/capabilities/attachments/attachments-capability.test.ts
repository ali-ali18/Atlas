import { describe, expect, it } from "vitest";
import { setupPreset } from "../../presets/presets.js";
import { FakeFileStore, FakeSearch } from "../../presets/fakes.js";
import type { Ports } from "../../ports/index.js";
import { FakeAttachments, encodeText, sheet } from "../../testing/attachments-fakes.js";
import { FakeCardSandbox } from "../../testing/payment-fakes.js";
import type { Tool } from "../../tools/define-tool.js";
import type { ToolContext } from "../../tools/types.js";
import { ATTACHMENT_KINDS, createAttachmentsCapability } from "./index.js";

const LONG_TEXT = "linha de texto ".repeat(1500); // 22.500 caracteres
const CSV_ROWS = [["nome", "valor"], ["ana", "10"], ["beto", "20"], ["caio", "30"], ["dani", "40"]];
const ZIP_ENTRIES = { "dados/notas.txt": encodeText("nota um\nnota dois"), "dados/imagem.bin": new Uint8Array([0, 1, 2, 3, 255]) };

const FILES = [
	{ ownerId: "dono-a", id: "txt1", filename: "relatorio.txt", kind: "text" as const, text: LONG_TEXT },
	{ ownerId: "dono-a", id: "csv1", filename: "vendas.csv", kind: "csv" as const, tables: [sheet("vendas", CSV_ROWS)] },
	{ ownerId: "dono-a", id: "zip1", filename: "pacote.zip", kind: "zip" as const, entries: ZIP_ENTRIES, bytes: new Uint8Array([80, 75]) },
	{ ownerId: "dono-b", id: "txtb", filename: "segredo-b.txt", kind: "text" as const, text: "dado do dono B" },
];

function setup(over: { computer?: boolean; sandbox?: FakeCardSandbox } = {}) {
	const files = new FakeAttachments(FILES.map((item) => ({ ...item })));
	const sandbox = over.sandbox ?? new FakeCardSandbox();
	const cap = createAttachmentsCapability({ files, ...(over.computer && { computer: true }) });
	const tool = (name: string): Tool => {
		const found = cap.tools.find((t) => t.name === name);
		if (!found) throw new Error(`tool ${name} not in the capability`);
		return found;
	};
	const ctx = (ownerId = "dono-a"): ToolContext => ({ runId: "run-1", ownerId, ports: { sandbox } as unknown as Ports });
	return { files, sandbox, cap, tool, ctx };
}

describe("capacidade attachments: contrato", () => {
	it("é lazy, tem resumo curto e as tools de leitura marcadas como dado do dono não confiável", () => {
		const { cap, tool } = setup();
		expect(cap.core).toBe(false);
		expect(cap.id).toBe("attachments");
		expect(cap.summary.length).toBeLessThanOrEqual(160);
		for (const name of ["attachment_list", "attachment_read"]) {
			expect(tool(name)).toMatchObject({ effect: "read", trust: "untrusted", source: "file", privateData: true, ownerData: "file" });
		}
	});

	it("sem computador a cópia não é oferecida; com computador entra como escrita interna", () => {
		expect(setup().cap.tools.map((t) => t.name)).toEqual(["attachment_list", "attachment_read"]);
		const withComputer = setup({ computer: true });
		expect(withComputer.cap.tools.map((t) => t.name)).toEqual(["attachment_list", "attachment_read", "attachment_to_computer"]);
		expect(withComputer.tool("attachment_to_computer")).toMatchObject({ effect: "write_internal", trust: "untrusted", source: "file", privateData: false });
	});

	it("entra no preset full só com a porta (opt-in): sem ela nem aparece em `unavailable`", () => {
		const base = { search: new FakeSearch(), files: new FakeFileStore() };
		const without = setupPreset("full", base);
		expect(without.registry.ids()).not.toContain("attachments");
		expect(without.unavailable).not.toContain("attachments");
		const withPort = setupPreset("full", { ...base, attachments: { files: new FakeAttachments(FILES) }, browser: true });
		expect(withPort.registry.ids()).toContain("attachments");
		expect(withPort.registry.core().map((c) => c.id)).not.toContain("attachments");
		expect(withPort.registry.capabilities.find((c) => c.id === "attachments")?.tools.map((t) => t.name)).toEqual(["attachment_list", "attachment_read", "attachment_to_computer"]);
	});
});

describe("attachment_list", () => {
	it("sem id lista só os anexos do dono da conversa", async () => {
		const { tool, ctx } = setup();
		const result = await tool("attachment_list").run({}, ctx("dono-a"));
		expect(result).toMatchObject({ ok: true });
		const summary = (result as { summary: string }).summary;
		expect(summary).toContain('"relatorio.txt"');
		expect(summary).toContain("id txt1");
		expect(summary).not.toContain("segredo-b");
	});

	it("outro dono não vê anexo nenhum", async () => {
		const { tool, ctx } = setup();
		const result = await tool("attachment_list").run({ id: "zip1" }, ctx("dono-b"));
		expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Attachment not found") });
		const empty = await tool("attachment_list").run({}, ctx("dono-c"));
		expect((empty as { summary: string }).summary).toContain("has not attached any files");
	});

	it("com o id de um zip lista as entradas, sem extrair; com o id de texto diz para ler", async () => {
		const { tool, ctx } = setup();
		const archive = (await tool("attachment_list").run({ id: "zip1" }, ctx())) as { summary: string };
		expect(archive.summary).toContain("2 entries");
		expect(archive.summary).toContain("dados/notas.txt");
		const plain = (await tool("attachment_list").run({ id: "txt1" }, ctx())) as { summary: string };
		expect(plain.summary).toContain("not an archive; read it with attachment_read");
	});

	it("valida o id: formato errado é recusado com a regra", async () => {
		const { tool, ctx } = setup();
		const result = await tool("attachment_list").run({ id: "../../etc" }, ctx());
		expect(result).toMatchObject({ ok: false });
	});
});

describe("attachment_read", () => {
	it("texto em partes: diz o intervalo, o total e como pedir o resto; a última parte fecha", async () => {
		const { tool, ctx } = setup();
		const first = (await tool("attachment_read").run({ id: "txt1", length: 5000 }, ctx())) as { summary: string };
		expect(first.summary).toContain("characters 0-5000 of 22500");
		expect(first.summary).toContain('Next: attachment_read with id "txt1" with offset 5000');
		const last = (await tool("attachment_read").run({ id: "txt1", offset: 20000 }, ctx())) as { summary: string };
		expect(last.summary).toContain("End of the content");
	});

	it("texto: find devolve as posições; sem achado diz isso", async () => {
		const { tool, ctx } = setup();
		const hit = (await tool("attachment_read").run({ id: "txt1", find: "texto" }, ctx())) as { summary: string };
		expect(hit.summary).toMatch(/8 match\(es\) for "texto"/);
		const miss = (await tool("attachment_read").run({ id: "txt1", find: "inexistente" }, ctx())) as { summary: string };
		expect(miss.summary).toContain('no match for "inexistente"');
	});

	it("planilha: linhas a partir de start_row com o cabeçalho e o próximo passo; aba inexistente é dita", async () => {
		const { tool, ctx } = setup();
		const page = (await tool("attachment_read").run({ id: "csv1", start_row: 2, rows: 2 }, ctx())) as { summary: string };
		expect(page.summary).toContain("rows 2-3 of 5");
		expect(page.summary).toContain('start_row 4');
		expect(page.summary).toContain("| ana | 10 |");
		const missing = (await tool("attachment_read").run({ id: "csv1", sheet: "nao-existe" }, ctx())) as { summary: string };
		expect(missing.summary).toContain('Sheet "nao-existe" not found');
	});

	it("zip: lê uma entrada de texto; binário sai como trecho hexadecimal; entrada ausente é dita", async () => {
		const { tool, ctx } = setup();
		const text = (await tool("attachment_read").run({ id: "zip1", entry: "dados/notas.txt" }, ctx())) as { summary: string };
		expect(text.summary).toContain("nota um");
		const binary = (await tool("attachment_read").run({ id: "zip1", entry: "dados/imagem.bin" }, ctx())) as { summary: string };
		expect(binary.summary).toContain("is binary");
		const absent = (await tool("attachment_read").run({ id: "zip1", entry: "nao/existe.txt" }, ctx())) as { summary: string };
		expect(absent.summary).toContain('Entry "nao/existe.txt" not found');
	});

	it("outro dono: not found, nada é lido; campo desconhecido falha com a lista aceita", async () => {
		const { tool, ctx, files } = setup();
		const other = await tool("attachment_read").run({ id: "txt1" }, ctx("dono-b"));
		expect(other).toMatchObject({ ok: false, error: expect.stringContaining("Attachment not found") });
		expect(files.opened.at(-1)).toEqual({ ownerId: "dono-b", id: "txt1" });
		const unknown = await tool("attachment_read").run({ id: "txt1", format: "pdf" }, ctx());
		expect(unknown).toMatchObject({ ok: false, error: expect.stringContaining("Unknown field(s)") });
	});

	it("arquivo que sumiu do armazenamento falha com o motivo (sem sucesso falso)", async () => {
		const files = new FakeAttachments([{ ownerId: "dono-a", id: "bin1", filename: "dados.bin", kind: "other", bytes: new Uint8Array([1, 2, 3]), gone: true }]);
		const cap = createAttachmentsCapability({ files });
		const read = cap.tools.find((t) => t.name === "attachment_read")!;
		const result = await read.run({ id: "bin1" }, { runId: "r", ownerId: "dono-a", ports: {} as Ports });
		expect(result).toMatchObject({ ok: false, error: expect.stringContaining("no longer available") });
	});
});

describe("attachment_to_computer", () => {
	it("copia pela porta Sandbox com o kind de anexos e o nome do arquivo, devolvendo o caminho", async () => {
		const sandbox = new FakeCardSandbox();
		sandbox.respond = () => ({ ok: true, data: { path: "anexos/relatorio.txt" } });
		const { tool, ctx } = setup({ computer: true, sandbox });
		const result = (await tool("attachment_to_computer").run({ id: "txt1" }, ctx())) as { summary: string };
		expect(result.summary).toContain("anexos/relatorio.txt");
		expect(result.summary).toContain("It was not executed");
		const sent = sandbox.actions.at(-1)!;
		expect(sent.userId).toBe("dono-a");
		expect(sent.action.kind).toBe(ATTACHMENT_KINDS.copy);
		expect(sent.action.params).toMatchObject({ name: "relatorio.txt" });
		expect((sent.action.params as { bytes: Uint8Array }).bytes.byteLength).toBe(LONG_TEXT.length);
	});

	it("entrada de zip copia só ela, com o nome do último trecho", async () => {
		const sandbox = new FakeCardSandbox();
		sandbox.respond = () => ({ ok: true, data: { path: "anexos/notas.txt" } });
		const { tool, ctx } = setup({ computer: true, sandbox });
		await tool("attachment_to_computer").run({ id: "zip1", entry: "dados/notas.txt" }, ctx());
		const params = sandbox.actions.at(-1)!.action.params as { name: string; bytes: Uint8Array };
		expect(params.name).toBe("notas.txt");
		expect(new TextDecoder().decode(params.bytes)).toBe("nota um\nnota dois");
	});

	it("nome com caminho ou '..' vira só o último trecho seguro (nunca sai da pasta anexos)", async () => {
		const sandbox = new FakeCardSandbox();
		const { tool, ctx } = setup({ computer: true, sandbox });
		await tool("attachment_to_computer").run({ id: "txt1", name: "../../etc/passwd" }, ctx());
		expect(sandbox.actions.at(-1)!.action.params).toMatchObject({ name: "passwd" });
		const empty = await tool("attachment_to_computer").run({ id: "txt1", name: "../.." }, ctx());
		expect(empty).toMatchObject({ ok: false });
	});

	it("sem VM a falha é honesta (o motivo da porta chega ao modelo)", async () => {
		const sandbox = new FakeCardSandbox();
		sandbox.respond = () => ({ ok: false, error: "The computer could not be started right now." });
		const { tool, ctx } = setup({ computer: true, sandbox });
		const result = await tool("attachment_to_computer").run({ id: "txt1" }, ctx());
		expect(result).toMatchObject({ ok: false, error: "The computer could not be started right now." });
	});

	it("resposta sem caminho não vira sucesso; outro dono não chega à VM", async () => {
		const sandbox = new FakeCardSandbox();
		sandbox.respond = () => ({ ok: true, data: {} });
		const { tool, ctx } = setup({ computer: true, sandbox });
		expect(await tool("attachment_to_computer").run({ id: "txt1" }, ctx())).toMatchObject({ ok: false });
		const before = sandbox.actions.length;
		const other = await tool("attachment_to_computer").run({ id: "txt1" }, ctx("dono-b"));
		expect(other).toMatchObject({ ok: false, error: expect.stringContaining("Attachment not found") });
		expect(sandbox.actions.length).toBe(before);
	});
});
