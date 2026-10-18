import { describe, expect, it, vi } from "vitest";
import { SandboxShellError, type SandboxManager } from "@workspace/sandbox";
import type { CompleteChatWithToolsResult, LlmToolCall } from "@workspace/llm";
import { COMPUTER_USE_TOOLS, runComputerUse } from "./computer-use.js";
import {
	SANDBOX_SHELL_TOOLS,
	SANDBOX_SHELL_TOOL_NAMES,
	executeSandboxShellTool,
	formatDownload,
	formatShell,
	sandboxShellAllowedForOrigin,
	sandboxShellBlocked,
} from "./tools/sandbox-shell.js";

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
const result = (over = {}) => ({ background: false, exitCode: 0, stdout: "ok", stderr: "", durationMs: 1200, timedOut: false, truncated: false, ...over });

function managerWith(methods: Record<string, unknown>) {
	return methods as unknown as SandboxManager;
}
const ctxFor = (manager: SandboxManager) => ({ manager, getSessionId: async () => "s1" });

describe("sandbox shell tools: definições", () => {
	it("estão no catálogo de computer use com descrições orientadas a trabalho em lote", () => {
		for (const name of SANDBOX_SHELL_TOOL_NAMES) {
			expect(COMPUTER_USE_TOOLS.some((tool) => tool.function.name === name)).toBe(true);
		}
		const shell = SANDBOX_SHELL_TOOLS.find((t) => t.function.name === "sandbox_shell")!.function.description!;
		expect(shell).toContain("background:true");
		expect(shell).toContain("connectOverCDP");
		expect(shell).toContain("page by page");
		expect(SANDBOX_SHELL_TOOLS.find((t) => t.function.name === "sandbox_read")!.function.description).toContain("pdftotext");
		expect(SANDBOX_SHELL_TOOLS.find((t) => t.function.name === "sandbox_download")!.function.description).toContain("cookies");
	});
});

describe("sandbox shell tools: gating", () => {
	it("exceção bloqueada tira só a tool afetada; webhook/subagente só leem", () => {
		expect(sandboxShellBlocked(policy, "sandbox_shell")).toBe(false);
		const blocked = { ...policy, exceptions: [{ tool: "sandbox_shell", mode: "blocked" as const }] };
		expect(sandboxShellBlocked(blocked, "sandbox_shell")).toBe(true);
		expect(sandboxShellBlocked(blocked, "sandbox_read")).toBe(false);
		expect(sandboxShellAllowedForOrigin("sandbox_shell", "webhook")).toBe(false);
		expect(sandboxShellAllowedForOrigin("sandbox_download", "subagent")).toBe(false);
		expect(sandboxShellAllowedForOrigin("sandbox_read", "webhook")).toBe(true);
		expect(sandboxShellAllowedForOrigin("sandbox_shell", "routine")).toBe(true);
		expect(sandboxShellAllowedForOrigin("sandbox_shell", "chat")).toBe(true);
	});
});

describe("sandbox shell tools: execução", () => {
	it("sandbox_shell limita o timeout em primeiro plano a 170s e formata saída/exit", async () => {
		const execShell = vi.fn(async () => result({ stdout: "linha", exitCode: 2 }));
		const out = await executeSandboxShellTool("sandbox_shell", { command: "ls", timeout_s: 500 }, ctxFor(managerWith({ execShell })));
		expect(execShell).toHaveBeenCalledWith("s1", { command: "ls", cwd: undefined, timeoutS: 170, background: false });
		expect(out.summary).toContain("exit 2 in 1.2s");
		expect(out.summary).toContain("stdout:\nlinha");
	});

	it("background devolve o job id; timeout é sinalizado; segredos são redigidos", async () => {
		const execShell = vi.fn(async () => result({ background: true, jobId: "abcdef012345", exitCode: null }));
		const bg = await executeSandboxShellTool("sandbox_shell", { command: "python3 crawl.py", background: true, timeout_s: 3000 }, ctxFor(managerWith({ execShell })));
		expect(execShell).toHaveBeenCalledWith("s1", expect.objectContaining({ background: true, timeoutS: 3000 }));
		expect(bg.summary).toContain("job_id=abcdef012345");
		expect(formatShell(result({ exitCode: 124, timedOut: true }))).toContain("TIMED OUT");
		const leaked = vi.fn(async () => result({ stdout: "Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz0123456789" }));
		const redacted = await executeSandboxShellTool("sandbox_shell", { command: "env" }, ctxFor(managerWith({ execShell: leaked })));
		expect(redacted.summary).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789");
	});

	it("sandbox_shell_wait repassa job/offset e mostra só a saída nova", async () => {
		const execShellWait = vi.fn(async () => ({ jobId: "abcdef012345", status: "done" as const, exitCode: 0, output: "fim", nextOffset: 3, truncated: false }));
		const out = await executeSandboxShellTool("sandbox_shell_wait", { job_id: "abcdef012345", timeout_s: 10, offset: 0 }, ctxFor(managerWith({ execShellWait })));
		expect(execShellWait).toHaveBeenCalledWith("s1", { jobId: "abcdef012345", timeoutS: 10, offset: 0 });
		expect(out.summary).toContain("done (exit 0)");
	});

	it("sandbox_read de PDF devolve o texto extraído com aviso de conteúdo não confiável", async () => {
		const execReadFile = vi.fn(async () => ({ path: "/home/atlas/work/aula.pdf", kind: "pdf" as const, size: 10, content: "Prazo: sexta", totalLines: 1, nextOffset: null, truncated: false }));
		const out = await executeSandboxShellTool("sandbox_read", { path: "aula.pdf" }, ctxFor(managerWith({ execReadFile })));
		expect(out.summary).toContain("Prazo: sexta");
		expect(out.summary).toContain("aula.pdf (pdf, 1 lines)");
		expect(out.summary.toLowerCase()).toContain("untrusted");
	});

	it("sandbox_download avisa quando a resposta é HTML (login) e repassa use_browser_session=false", async () => {
		const execDownload = vi.fn(async () => ({ path: "/home/atlas/work/downloads/a", httpStatus: 200, contentType: "text/html", bytes: 10, usedBrowserSession: false }));
		const out = await executeSandboxShellTool("sandbox_download", { url: "https://x.test/a", use_browser_session: false }, ctxFor(managerWith({ execDownload })));
		expect(execDownload).toHaveBeenCalledWith("s1", { url: "https://x.test/a", path: undefined, useBrowserSession: false });
		expect(out.summary).toContain("login page");
		expect(formatDownload({ path: "p", httpStatus: 200, contentType: "application/pdf", bytes: 5, usedBrowserSession: true })).toContain("with browser session");
	});

	it("erros esperados viram texto; erros de infraestrutura propagam; argumentos inválidos falham", async () => {
		const execListDir = vi.fn(async () => {
			throw new SandboxShellError("Diretório não encontrado: /x");
		});
		expect((await executeSandboxShellTool("sandbox_list", { path: "/x" }, ctxFor(managerWith({ execListDir })))).summary).toBe("Error: Diretório não encontrado: /x");
		const boom = vi.fn(async () => {
			throw new Error("Sandbox session not found: s1");
		});
		await expect(executeSandboxShellTool("sandbox_read", { path: "a" }, ctxFor(managerWith({ execReadFile: boom })))).rejects.toThrow("not found");
		await expect(executeSandboxShellTool("sandbox_shell", {}, ctxFor(managerWith({})))).rejects.toThrow("command");
		await expect(executeSandboxShellTool("sandbox_shell", { command: "ls", timeout_s: -1 }, ctxFor(managerWith({})))).rejects.toThrow("timeout_s");
	});
});

describe("sandbox shell tools: exposição no run", () => {
	const call = (id: string, name: string, args: Record<string, unknown>): LlmToolCall => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
	const done: CompleteChatWithToolsResult = { model: "m", message: { role: "assistant", content: "Finished." } };

	async function exposedTools(extra: Record<string, unknown>) {
		let names: string[] = [];
		await runComputerUse({
			manager: {} as SandboxManager,
			getSessionId: async () => "unused",
			apiKey: "test",
			model: "m",
			runId: "run-shell",
			userId: "user-a",
			origin: "chat",
			autonomy: policy,
			messages: [{ role: "user" as const, content: "Baixe os PDFs do AVA." }],
			onEvent: () => undefined,
			streamChat: async (params) => {
				names = (params.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name);
				return done;
			},
			...extra,
		} as Parameters<typeof runComputerUse>[0]);
		return names;
	}

	it("aparecem com a sandbox ligada, somem com ela desligada e respeitam a exceção bloqueada", async () => {
		const on = await exposedTools({ sandboxEnabled: true });
		for (const name of SANDBOX_SHELL_TOOL_NAMES) expect(on).toContain(name);
		const off = await exposedTools({ sandboxEnabled: false });
		for (const name of SANDBOX_SHELL_TOOL_NAMES) expect(off).not.toContain(name);
		const blocked = await exposedTools({ sandboxEnabled: true, autonomy: { level: "balanced", exceptions: [{ tool: "sandbox_shell", mode: "blocked" }] } });
		expect(blocked).not.toContain("sandbox_shell");
		expect(blocked).toContain("sandbox_read");
		const webhook = await exposedTools({ sandboxEnabled: true, origin: "webhook" });
		expect(webhook).not.toContain("sandbox_shell");
		expect(webhook).not.toContain("sandbox_download");
		expect(webhook).toContain("sandbox_read");
	});

	it("o modelo chama sandbox_shell e o resultado volta no histórico", async () => {
		const execShell = vi.fn(async () => result({ stdout: "pong" }));
		let step = 0;
		const seen: string[] = [];
		await runComputerUse({
			manager: managerWith({ execShell }),
			getSessionId: async () => "s1",
			sandboxEnabled: true,
			apiKey: "test",
			model: "m",
			runId: "run-shell-2",
			userId: "user-a",
			origin: "chat",
			autonomy: policy,
			messages: [{ role: "user" as const, content: "Rode um script python que imprime pong." }],
			onEvent: () => undefined,
			streamChat: async (params) => {
				seen.push(JSON.stringify(params.messages));
				return step++ === 0 ? { model: "m", message: { role: "assistant", content: null, tool_calls: [call("t1", "sandbox_shell", { command: "echo pong" })] } } : done;
			},
		} as Parameters<typeof runComputerUse>[0]);
		expect(execShell).toHaveBeenCalledTimes(1);
		expect(seen[1]).toContain("pong");
	});
});
