import { describe, expect, it, vi } from "vitest";
import {
	downloadToSandbox,
	listSandboxDir,
	readSandboxFile,
	resolveSandboxPath,
	runShell,
	SandboxShellError,
	truncateOutput,
	waitShell,
	type ShellExecOptions,
	type ShellExecResult,
} from "./shell.js";

const ok = (stdout = "", stderr = "", exitCode = 0): ShellExecResult => ({ stdout, stderr, exitCode });

function fakeExec(handler: (options: ShellExecOptions, n: number) => ShellExecResult | Promise<ShellExecResult>) {
	const calls: ShellExecOptions[] = [];
	const exec = vi.fn(async (options: ShellExecOptions) => {
		calls.push(options);
		return handler(options, calls.length - 1);
	});
	return { exec, calls };
}

describe("sandbox shell: runShell", () => {
	it("roda como usuário não-root, no workdir, com timeout padrão de 60s", async () => {
		const { exec, calls } = fakeExec(() => ok("hi\n"));
		const result = await runShell(exec, { command: "echo hi" });
		expect(calls[0]).toMatchObject({
			cmd: ["timeout", "-k", "3", "60", "bash", "-lc", "echo hi"],
			user: "atlas",
			workingDir: "/home/atlas/work",
		});
		expect(result).toMatchObject({ exitCode: 0, stdout: "hi\n", timedOut: false, background: false });
	});

	it("resolve cwd relativo e limita o timeout", async () => {
		const { exec, calls } = fakeExec(() => ok());
		await runShell(exec, { command: "ls", cwd: "sub/dir", timeoutS: 99999 });
		expect(calls[0]!.workingDir).toBe("/home/atlas/work/sub/dir");
		expect(calls[0]!.cmd[3]).toBe("600");
	});

	it("marca timeout (exit 124) e devolve o exit code", async () => {
		const { exec } = fakeExec(() => ok("", "", 124));
		expect(await runShell(exec, { command: "sleep 100", timeoutS: 1 })).toMatchObject({ exitCode: 124, timedOut: true });
		const failing = fakeExec(() => ok("", "boom", 2));
		expect(await runShell(failing.exec, { command: "false" })).toMatchObject({ exitCode: 2, stderr: "boom", timedOut: false });
	});

	it("trunca saída grande mantendo começo e fim e avisando", async () => {
		const big = `START${"x".repeat(100_000)}END`;
		const { exec } = fakeExec(() => ok(big));
		const result = await runShell(exec, { command: "cat big" });
		expect(result.truncated).toBe(true);
		expect(result.stdout.length).toBeLessThan(17_000);
		expect(result.stdout.startsWith("START")).toBe(true);
		expect(result.stdout.endsWith("END")).toBe(true);
		expect(result.stdout).toContain("chars omitidos");
		expect(truncateOutput("curto")).toEqual({ text: "curto", truncated: false });
	});

	it("rejeita comando vazio", async () => {
		const { exec } = fakeExec(() => ok());
		await expect(runShell(exec, { command: "   " })).rejects.toThrow(SandboxShellError);
		expect(exec).not.toHaveBeenCalled();
	});

	it("background: devolve job id e passa o comando por env (sem injeção no script)", async () => {
		const { exec, calls } = fakeExec(() => ok("started\n"));
		const result = await runShell(exec, { command: "python3 job.py; echo $(whoami)", background: true });
		expect(result.background).toBe(true);
		expect(result.jobId).toMatch(/^[a-f0-9]{12}$/);
		expect(result.exitCode).toBeNull();
		expect(calls[0]!.user).toBe("atlas");
		expect(calls[0]!.env).toContain("JOB_CMD=python3 job.py; echo $(whoami)");
		expect(calls[0]!.cmd[2]).not.toContain("python3 job.py");
	});
});

describe("sandbox shell: waitShell", () => {
	const jobId = "abcdef012345";
	const isProbe = (o: ShellExecOptions) => String(o.cmd[2]).includes("echo running");

	it("rejeita job id malformado (sem path traversal)", async () => {
		const { exec } = fakeExec(() => ok());
		await expect(waitShell(exec, { jobId: "../../etc/passwd" })).rejects.toThrow("job_id");
		expect(exec).not.toHaveBeenCalled();
	});

	it("espera até terminar e devolve só a saída nova (cursor incremental)", async () => {
		let probes = 0;
		const { exec, calls } = fakeExec((options) => {
			if (isProbe(options)) {
				probes += 1;
				return ok(probes < 3 ? "running\n" : "done 0\n");
			}
			return ok("linha1\nlinha2\n");
		});
		const sleep = vi.fn(async () => undefined);
		const result = await waitShell(exec, { jobId, timeoutS: 30 }, { sleep });
		expect(result).toMatchObject({ status: "done", exitCode: 0, output: "linha1\nlinha2\n", nextOffset: 14 });
		expect(sleep).toHaveBeenCalledTimes(2);
		expect(calls.at(-1)!.cmd.at(-1)).toBe("0");
	});

	it("estoura o tempo de espera e continua running com cursor guardado", async () => {
		let clock = 0;
		const { exec, calls } = fakeExec((options) => (isProbe(options) ? ok("running\n") : ok("parcial")));
		const first = await waitShell(exec, { jobId, timeoutS: 2 }, { now: () => clock, sleep: async (ms) => void (clock += ms) });
		expect(first).toMatchObject({ status: "running", exitCode: null, output: "parcial", nextOffset: 7 });
		clock = 0;
		await waitShell(exec, { jobId, timeoutS: 0 }, { now: () => clock, sleep: async () => undefined });
		expect(calls.at(-1)!.cmd.at(-1)).toBe("7");
	});

	it("job inexistente vira erro claro", async () => {
		const { exec } = fakeExec(() => ok("missing\n"));
		await expect(waitShell(exec, { jobId: "000000000000" })).rejects.toThrow("Job não encontrado");
	});

	it("propaga exit code diferente de zero", async () => {
		const { exec } = fakeExec((options) => (isProbe(options) ? ok("done 3\n") : ok("erro")));
		expect(await waitShell(exec, { jobId: "111111111111" })).toMatchObject({ status: "done", exitCode: 3 });
	});
});

describe("sandbox shell: readSandboxFile", () => {
	it("lê texto com paginação por linhas", async () => {
		const text = Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n");
		const { exec } = fakeExec((o) => (o.cmd[0] === "stat" ? ok("100 regular file\n") : ok(text)));
		const page = await readSandboxFile(exec, { path: "notes.txt", offset: 2, limit: 3 });
		expect(page).toMatchObject({ kind: "text", content: "l2\nl3\nl4", totalLines: 10, nextOffset: 5, truncated: true });
		const rest = await readSandboxFile(exec, { path: "notes.txt", offset: 5, limit: 100 });
		expect(rest.nextOffset).toBeNull();
	});

	it("PDF usa pdftotext e cai em nota se não tiver texto", async () => {
		const { exec, calls } = fakeExec((o) => (o.cmd[0] === "stat" ? ok("5000 regular file\n") : ok("Aula 1\nConteudo")));
		const result = await readSandboxFile(exec, { path: "~/work/aula.PDF" });
		expect(calls[1]!.cmd.slice(0, 4)).toEqual(["pdftotext", "-layout", "-enc", "UTF-8"]);
		expect(calls[1]!.cmd).toContain("/home/atlas/work/aula.PDF");
		expect(result).toMatchObject({ kind: "pdf", content: "Aula 1\nConteudo" });
		const empty = fakeExec((o) => (o.cmd[0] === "stat" ? ok("5 regular file") : ok("  \n")));
		expect((await readSandboxFile(empty.exec, { path: "scan.pdf" })).note).toContain("escaneado");
	});

	it("pdftotext com erro vira SandboxShellError", async () => {
		const { exec } = fakeExec((o) => (o.cmd[0] === "stat" ? ok("5 regular file") : ok("", "Syntax Error", 1)));
		await expect(readSandboxFile(exec, { path: "x.pdf" })).rejects.toThrow("pdftotext falhou");
	});

	it("imagem devolve nota sem ler bytes; binário e diretório são tratados", async () => {
		const img = fakeExec(() => ok("2048 regular file"));
		const res = await readSandboxFile(img.exec, { path: "/home/atlas/work/a.png" });
		expect(res).toMatchObject({ kind: "image", content: "" });
		expect(res.note).toContain("file:///home/atlas/work/a.png");
		expect(img.calls).toHaveLength(1);
		const bin = fakeExec((o) => (o.cmd[0] === "stat" ? ok("3 regular file") : ok("a\0b")));
		expect((await readSandboxFile(bin.exec, { path: "x.bin" })).kind).toBe("binary");
		const dir = fakeExec(() => ok("4096 directory"));
		await expect(readSandboxFile(dir.exec, { path: "d" })).rejects.toThrow("sandbox_list");
		const missing = fakeExec(() => ok("", "", 1));
		await expect(readSandboxFile(missing.exec, { path: "nope" })).rejects.toThrow("não encontrado");
	});

	it("limita caracteres por leitura", async () => {
		const body = Array.from({ length: 500 }, () => "x".repeat(200)).join("\n");
		const { exec } = fakeExec((o) => (o.cmd[0] === "stat" ? ok("9 regular file") : ok(body)));
		const result = await readSandboxFile(exec, { path: "big.txt" });
		expect(result.content.length).toBeLessThanOrEqual(40_000);
		expect(result.truncated).toBe(true);
		expect(result.nextOffset).toBeGreaterThan(0);
	});
});

describe("sandbox shell: list, download e paths", () => {
	it("lista ordenando diretórios primeiro e escondendo dirs internos", async () => {
		const out = "f\t10\t2026-01-01 10:00\tb.txt\nd\t4096\t2026-01-01 10:00\tz\nd\t4096\t2026-01-01 10:00\t.jobs\nf\t5\t2026-01-01 10:00\ta.txt\n";
		const { exec } = fakeExec(() => ok(out));
		const result = await listSandboxDir(exec, { path: "." });
		expect(result.entries.map((e) => e.name)).toEqual(["z", "a.txt", "b.txt"]);
		expect(result.total).toBe(3);
	});

	it("resolve caminhos e rejeita vazio/NUL", () => {
		expect(resolveSandboxPath("a/b")).toBe("/home/atlas/work/a/b");
		expect(resolveSandboxPath("~/x")).toBe("/home/atlas/x");
		expect(resolveSandboxPath("/etc/hosts")).toBe("/etc/hosts");
		expect(() => resolveSandboxPath("")).toThrow(SandboxShellError);
		expect(() => resolveSandboxPath("a\0b")).toThrow(SandboxShellError);
	});

	it("download usa cookies do navegador, baixa como atlas e apaga o jar", async () => {
		const { exec, calls } = fakeExec((o) => (o.cmd[0] === "curl" ? ok("200\tapplication/pdf\t1234") : ok("cookies:3")));
		const result = await downloadToSandbox(exec, { url: "https://ava.example.edu/pluginfile.php/1/aula%201.pdf" });
		const prep = calls[0]!;
		expect(prep.user).toBe("root");
		expect(prep.cmd.join(" ")).toContain("export-cookies.mjs");
		const curl = calls[1]!;
		expect(curl.user).toBe("atlas");
		expect(curl.cmd).toContain("-b");
		expect(curl.cmd).toContain("/home/atlas/work/downloads/aula 1.pdf");
		expect(curl.cmd.at(-2)).toBe("--");
		expect(calls[2]!.cmd[0]).toBe("rm");
		expect(result).toMatchObject({ httpStatus: 200, contentType: "application/pdf", bytes: 1234, usedBrowserSession: true });
	});

	it("download sem sessão e com falha do export de cookies segue sem cookies; só http(s)", async () => {
		const { exec, calls } = fakeExec((o) => (o.user === "root" ? ok("", "no chrome", 1) : ok("200\ttext/html\t5")));
		const res = await downloadToSandbox(exec, { url: "http://x.test/a", path: "out/", useBrowserSession: true });
		expect(res.usedBrowserSession).toBe(false);
		expect(res.note).toContain("sem cookies");
		expect(calls.at(-1)!.cmd).not.toContain("-b");
		await expect(downloadToSandbox(exec, { url: "file:///etc/passwd" })).rejects.toThrow("http(s)");
		await expect(downloadToSandbox(exec, { url: "nao e url" })).rejects.toThrow("url inválida");
		const none = fakeExec(() => ok("200\tx\t1"));
		await downloadToSandbox(none.exec, { url: "https://x.test/f.zip", useBrowserSession: false });
		expect(none.calls).toHaveLength(1);
	});

	it("download com curl falhando vira erro", async () => {
		const { exec } = fakeExec(() => ok("", "curl: (22) 403", 22));
		await expect(downloadToSandbox(exec, { url: "https://x.test/f", useBrowserSession: false })).rejects.toThrow("Download falhou");
	});
});

describe("sandbox shell: writeSandboxFile (anexos do usuário)", () => {
  const bytes = Uint8Array.from([0x50, 0x4b, 3, 4, 0, 255]);

  it("envia os bytes pela entrada padrão (nunca por argumento) para um caminho dentro do home", async () => {
    const { writeSandboxFile } = await import("./shell.js");
    const { exec, calls } = fakeExec(() => ok());
    const result = await writeSandboxFile(exec, { path: "anexos/pacote.zip", bytes });
    expect(result).toEqual({ path: "/home/atlas/work/anexos/pacote.zip", bytes: 6 });
    expect(calls[0]?.stdin).toBe(bytes);
    expect(calls[0]?.user).toBe("atlas");
    expect(calls[0]?.cmd.join(" ")).not.toContain("PK");
    expect(calls[0]?.cmd.at(-1)).toBe("/home/atlas/work/anexos/pacote.zip");
  });

  it("recusa caminho fora do home, com .. e arquivo acima do teto; erro do comando vira SandboxShellError", async () => {
    const { writeSandboxFile, WRITE_FILE_MAX_BYTES } = await import("./shell.js");
    const { exec } = fakeExec(() => ok());
    await expect(writeSandboxFile(exec, { path: "/etc/cron.d/x", bytes })).rejects.toThrow(/dentro de/);
    await expect(writeSandboxFile(exec, { path: "~/../x", bytes })).rejects.toThrow(SandboxShellError);
    await expect(writeSandboxFile(exec, { path: "a.bin", bytes: new Uint8Array(WRITE_FILE_MAX_BYTES + 1) })).rejects.toThrow(/grande demais/);
    const failing = fakeExec(() => ok("", "disco cheio", 1));
    await expect(writeSandboxFile(failing.exec, { path: "a.bin", bytes })).rejects.toThrow(/disco cheio/);
  });
});
