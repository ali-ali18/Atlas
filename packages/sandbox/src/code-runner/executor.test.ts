import { Readable } from "node:stream";
import type Docker from "dockerode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCodeRunnerConfig, type CodeRunnerConfig } from "./config.js";
import {
	CODE_RUNNER_MARKER,
	CodeRunnerInputError,
	CodeRunnerUnavailableError,
	reapCodeRunnerContainers,
	resetCodeRunnerStateForTest,
	runCode,
	sanitizeInputName,
	truncateStream,
} from "./executor.js";
import { packTar, unpackTar } from "./tar.js";

const owner = { uid: 10001, gid: 10001 };
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

type FakeOptions = {
	imageMissing?: boolean;
	result?: Record<string, unknown> | null;
	outFiles?: Array<{ name: string; bytes: Uint8Array }>;
	/** O log nunca traz o marcador (execução travada). */
	hang?: boolean;
	/** O log acaba sem marcador (container morreu). */
	died?: boolean;
};

function fakeDocker(options: FakeOptions = {}) {
	const state = {
		spec: undefined as Docker.ContainerCreateOptions | undefined,
		puts: [] as Array<{ path: string; files: Array<{ name: string; bytes: Uint8Array }> }>,
		kill: vi.fn(async () => undefined),
		remove: vi.fn(async () => undefined),
	};
	const container = {
		start: vi.fn(async () => undefined),
		putArchive: vi.fn(async (tar: Buffer, opts: { path: string }) => {
			state.puts.push({ path: opts.path, files: unpackTar(tar) });
		}),
		logs: vi.fn(async () => {
			if (options.hang) return new Readable({ read() { /* nunca termina */ } });
			if (options.died) return Readable.from([Buffer.from("starting\n")]);
			return Readable.from([Buffer.from(`${CODE_RUNNER_MARKER}\n`)]);
		}),
		getArchive: vi.fn(async ({ path }: { path: string }) => {
			if (path === "/work/.result.json") {
				if (options.result === null) throw Object.assign(new Error("no such file"), { statusCode: 404 });
				const json = options.result ?? { exit_code: 0, timed_out: false, duration_ms: 12, stdout: "ok\n", stderr: "" };
				return Readable.from([packTar([{ name: ".result.json", bytes: bytes(JSON.stringify(json)) }], owner)]);
			}
			const files = (options.outFiles ?? []).map((file) => ({ name: `out/${file.name}`, bytes: file.bytes }));
			return Readable.from([packTar([{ dir: "out" }, ...files], owner)]);
		}),
		kill: state.kill,
		remove: state.remove,
	};
	const docker = {
		getImage: vi.fn(() => ({
			inspect: vi.fn(async () => {
				if (options.imageMissing) throw Object.assign(new Error("no such image"), { statusCode: 404 });
				return {};
			}),
		})),
		createContainer: vi.fn(async (spec: Docker.ContainerCreateOptions) => {
			state.spec = spec;
			return container;
		}),
	};
	return { docker: docker as unknown as Docker, state, container };
}

let config: CodeRunnerConfig;
beforeEach(() => {
	resetCodeRunnerStateForTest();
	config = { ...loadCodeRunnerConfig({}), enabled: true };
});
afterEach(() => vi.useRealTimers());

describe("runCode: isolamento do container", () => {
	it("cria o container com rede none, limites, rootfs somente leitura, sem capabilities e AutoRemove", async () => {
		const { docker, state } = fakeDocker();
		await runCode({ code: "print(1)", labels: { "atlas.run": "r1" } }, config, { docker });
		const spec = state.spec!;
		expect(spec.Image).toBe("atlas-code-runner:latest");
		expect(spec.NetworkDisabled).toBe(true);
		expect(spec.Labels).toMatchObject({ "atlas.code-runner": "1", "atlas.run": "r1" });
		const host = spec.HostConfig!;
		expect(host.NetworkMode).toBe("none");
		expect(host.Memory).toBe(512 * 1024 * 1024);
		expect(host.MemorySwap).toBe(512 * 1024 * 1024);
		expect(host.NanoCpus).toBe(1e9);
		expect(host.PidsLimit).toBeGreaterThan(0);
		expect(host.ReadonlyRootfs).toBe(true);
		expect(host.CapDrop).toEqual(["ALL"]);
		expect(host.SecurityOpt).toContain("no-new-privileges");
		expect(host.AutoRemove).toBe(true);
		expect(host.Privileged).toBe(false);
		const mounts = host.Mounts ?? [];
		expect(mounts.map((mount) => mount.Target).sort()).toEqual(["/tmp", "/work"]);
		// /work: volume anônimo tmpfs com limite de tamanho (putArchive só enxerga volumes); /tmp: tmpfs comum.
		expect(mounts.find((mount) => mount.Target === "/work")?.VolumeOptions?.DriverConfig?.Options).toMatchObject({ type: "tmpfs", o: expect.stringContaining("size=160m") });
		expect(mounts.find((mount) => mount.Target === "/tmp")?.Type).toBe("tmpfs");
		expect(host.Binds).toBeUndefined();
		expect(spec.User).toBe("10001:10001");
		expect(spec.Env).toContain("CODE_TIMEOUT_SEC=60");
	});

	it("limita o timeout a 120s e usa 60s por padrão", async () => {
		const first = fakeDocker();
		await runCode({ code: "x=1", timeoutSec: 9999 }, config, { docker: first.docker });
		expect(first.state.spec!.Env).toContain("CODE_TIMEOUT_SEC=120");
		const second = fakeDocker();
		await runCode({ code: "x=1" }, config, { docker: second.docker });
		expect(second.state.spec!.Env).toContain("CODE_TIMEOUT_SEC=60");
	});
});

describe("runCode: entrada e saída", () => {
	it("copia código e arquivos de entrada para /work e só depois sinaliza .go", async () => {
		const { docker, state } = fakeDocker();
		const result = await runCode({ code: "print(open('in/a.csv').read())", files: [{ name: "../x/a.csv", bytes: bytes("1,2") }, { name: "a.csv", bytes: bytes("3,4") }] }, config, { docker });
		expect(state.puts).toHaveLength(2);
		expect(state.puts[0]!.path).toBe("/work");
		expect(state.puts[0]!.files.map((file) => file.name).sort()).toEqual(["in/a-2.csv", "in/a.csv", "main.py"]);
		expect(text(state.puts[0]!.files.find((file) => file.name === "main.py")!.bytes)).toContain("open('in/a.csv')");
		expect(state.puts[1]!.files.map((file) => file.name)).toEqual([".go"]);
		expect(result.inputNames).toEqual(["a.csv", "a-2.csv"]);
	});

	it("rejeita código vazio, arquivos demais e entrada acima do limite", async () => {
		const { docker } = fakeDocker();
		await expect(runCode({ code: "   " }, config, { docker })).rejects.toBeInstanceOf(CodeRunnerInputError);
		const many = Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.txt`, bytes: bytes("x") }));
		await expect(runCode({ code: "x", files: many }, config, { docker })).rejects.toThrow(/arquivos demais/);
		const big = { name: "big.bin", bytes: new Uint8Array(26 * 1024 * 1024) };
		await expect(runCode({ code: "x", files: [big] }, config, { docker })).rejects.toThrow(/25 MB/);
	});

	it("devolve stdout, exit code, duração e os arquivos de /work/out", async () => {
		const { docker } = fakeDocker({
			result: { exit_code: 0, timed_out: false, duration_ms: 321, stdout: "total 42\n", stderr: "aviso" },
			outFiles: [{ name: "grafico.png", bytes: bytes("PNG") }, { name: "dados.csv", bytes: bytes("a,b") }],
		});
		const result = await runCode({ code: "print(1)" }, config, { docker });
		expect(result).toMatchObject({ exitCode: 0, timedOut: false, stdout: "total 42\n", stderr: "aviso", durationMs: 321, crashed: false });
		expect(result.outputs.map((file) => file.name)).toEqual(["dados.csv", "grafico.png"]);
		expect(text(result.outputs[1]!.bytes)).toBe("PNG");
	});

	it("respeita o limite de 10 arquivos e de bytes de saída", async () => {
		const files = Array.from({ length: 12 }, (_, i) => ({ name: `f${String(i).padStart(2, "0")}.txt`, bytes: bytes("x") }));
		const first = fakeDocker({ outFiles: files });
		const many = await runCode({ code: "x" }, config, { docker: first.docker });
		expect(many.outputs).toHaveLength(10);
		expect(many.omitted).toHaveLength(2);

		const small = { ...config, maxOutputBytes: 10 };
		const second = fakeDocker({ outFiles: [{ name: "a.bin", bytes: new Uint8Array(8).fill(1) }, { name: "b.bin", bytes: new Uint8Array(8).fill(1) }] });
		const capped = await runCode({ code: "x" }, small, { docker: second.docker });
		expect(capped.outputs.map((file) => file.name)).toEqual(["a.bin"]);
		expect(capped.omitted[0]).toMatch(/b\.bin/);
	});

	it("trunca stdout/stderr no teto de caracteres", async () => {
		const { docker } = fakeDocker({ result: { exit_code: 0, stdout: "a".repeat(50_000), stderr: "" } });
		const result = await runCode({ code: "x" }, config, { docker });
		expect(result.truncated).toBe(true);
		expect(result.stdout.length).toBeLessThan(20_300);
		expect(result.stdout).toContain("caracteres omitidos");
		expect(truncateStream("curto", 20_000)).toEqual({ text: "curto", truncated: false });
	});
});

describe("runCode: falhas", () => {
	it("imagem ausente vira 'o executor de código não está instalado'", async () => {
		const { docker } = fakeDocker({ imageMissing: true });
		const error = await runCode({ code: "x" }, config, { docker }).catch((e) => e);
		expect(error).toBeInstanceOf(CodeRunnerUnavailableError);
		expect(error.message).toMatch(/não está instalado/);
	});

	it("desligado por config não toca o Docker", async () => {
		const { docker } = fakeDocker();
		await expect(runCode({ code: "x" }, { ...config, enabled: false }, { docker })).rejects.toThrow(/desligado/);
		expect((docker as unknown as { createContainer: ReturnType<typeof vi.fn> }).createContainer).not.toHaveBeenCalled();
	});

	it("timeout do host mata o container e marca timedOut", async () => {
		vi.useFakeTimers();
		const { docker, state } = fakeDocker({ hang: true });
		const pending = runCode({ code: "while True: pass", timeoutSec: 1 }, config, { docker });
		await vi.advanceTimersByTimeAsync(1_000 + 20_000 + 50);
		const result = await pending;
		expect(result.timedOut).toBe(true);
		expect(state.kill).toHaveBeenCalled();
		expect(state.remove).toHaveBeenCalledWith({ force: true, v: true });
	});

	it("cancelamento pelo signal mata o container", async () => {
		const controller = new AbortController();
		const { docker, state } = fakeDocker({ hang: true });
		const pending = runCode({ code: "x", signal: controller.signal }, config, { docker });
		await vi.waitFor(() => expect(state.puts).toHaveLength(2));
		controller.abort();
		const result = await pending;
		expect(result.timedOut).toBe(true);
		expect(state.kill).toHaveBeenCalled();
	});

	it("container que morre sem marcador vira crashed (falta de memória)", async () => {
		const { docker } = fakeDocker({ died: true });
		const result = await runCode({ code: "x" }, config, { docker });
		expect(result.crashed).toBe(true);
		expect(result.stderr).toMatch(/memória/);
	});

	it("limita execuções simultâneas", async () => {
		const { docker } = fakeDocker({ hang: true });
		const one = { ...config, maxConcurrent: 1 };
		const controller = new AbortController();
		const first = runCode({ code: "x", signal: controller.signal }, one, { docker });
		await vi.waitFor(() => expect((docker as unknown as { createContainer: ReturnType<typeof vi.fn> }).createContainer).toHaveBeenCalled());
		await expect(runCode({ code: "y" }, one, { docker })).rejects.toThrow(/ocupado/);
		controller.abort();
		await first;
	});
});

describe("utilitários", () => {
	it("sanitizeInputName remove caminho, pontos iniciais e duplica com sufixo", () => {
		const taken = new Set<string>();
		expect(sanitizeInputName("../../etc/passwd", taken)).toBe("passwd");
		expect(sanitizeInputName(".env", taken)).toBe("env");
		expect(sanitizeInputName("Vendas 2024.xlsx", taken)).toBe("Vendas 2024.xlsx");
		expect(sanitizeInputName("vendas 2024.xlsx", taken)).toBe("vendas 2024-2.xlsx");
	});

	it("tar: ida e volta preserva nomes e bytes", () => {
		const packed = packTar([{ dir: "in" }, { name: "in/a.txt", bytes: bytes("olá") }], owner);
		expect(unpackTar(packed).map((file) => [file.name, text(file.bytes)])).toEqual([["in/a.txt", "olá"]]);
	});

	it("reaper do executor remove só containers antigos com o label", async () => {
		const now = Date.now();
		const remove = vi.fn(async () => undefined);
		const docker = {
			listContainers: vi.fn(async () => [
				{ Id: "old", Labels: { "atlas.code-runner.created": String(now - 3_600_000) } },
				{ Id: "new", Labels: { "atlas.code-runner.created": String(now - 1_000) } },
			]),
			getContainer: vi.fn(() => ({ remove })),
		} as unknown as Docker;
		expect(await reapCodeRunnerContainers(docker, { now })).toBe(1);
		expect(remove).toHaveBeenCalledTimes(1);
		expect((docker.listContainers as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ filters: { label: ["atlas.code-runner"] } });
	});
});
