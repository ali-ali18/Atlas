// Os comandos do atlas-install de verdade (cmdApt, cmdDeb, cmdRemove, cmdReinstall, prepare, trava),
// com um apt/dpkg FALSO injetado em `run`: confere o argv exato, o registro e o estado. Sem root, sem rede.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { atlasPaths, EXIT, InstallError, storedDebName } from "./atlas-install-lib.mjs";
import { createInstaller } from "./atlas-install.mjs";

const uid = process.getuid();
const gid = process.getgid();
const FLAGS = ["-y", "--no-install-recommends", "--no-remove", "-o", "Dpkg::Options::=--force-confold", "-o", "Dpkg::Options::=--force-confdef"];
const sha = (text) => createHash("sha256").update(text).digest("hex");

let root;
let paths;
let fake;
let clock;
let lockFile;
let inst;

function makeFake() {
	const state = {
		calls: [],
		installed: new Set(["git"]),
		index: new Set(["vlc", "git", "htop", "foo"]),
		debInfo: "Package: foo\nArchitecture: all\n",
		debInfoStatus: 0,
		failInstallFor: new Set(),
		removeAlso: [],
	};
	state.run = (cmd, args) => {
		state.calls.push({ cmd, args });
		const ok = (stdout = "") => ({ status: 0, stdout, stderr: "", timedOut: false });
		const bad = (status = 100) => ({ status, stdout: "", stderr: "", timedOut: false });
		const base = cmd.split("/").pop();
		if (base === "dpkg-query") return ok([...state.installed].map((n) => `${n} ii \n`).join(""));
		if (base === "apt-cache") return ok(state.index.has(args[1]) ? `${args[1]}\n` : "");
		if (base === "dpkg-deb") return state.debInfoStatus === 0 ? ok(state.debInfo) : bad(2);
		if (base === "dpkg") return ok(args[0] === "--print-architecture" ? "amd64\n" : "");
		if (base === "apt-get" && args[0] === "update") return ok();
		if (base === "apt-get" && args[0] === "install") {
			const targets = args.slice(1 + FLAGS.length);
			const names = targets.map((t) => (t.startsWith("/proc/") ? t.split("/").pop().split("_")[0] : t));
			if (names.some((n) => state.failInstallFor.has(n))) return bad();
			for (const target of targets) if (target.startsWith("/proc/") && !existsSync(target)) return bad(1);
			for (const n of names) state.installed.add(n);
			return ok();
		}
		if (base === "apt-get" && args[0] === "remove") {
			state.installed.delete(args[2]);
			for (const n of state.removeAlso) state.installed.delete(n);
			return ok();
		}
		throw new Error(`comando inesperado: ${cmd} ${args.join(" ")}`);
	};
	return state;
}

const installs = () => fake.calls.filter((c) => c.cmd.endsWith("apt-get") && c.args[0] === "install");
const manifest = () => JSON.parse(readFileSync(paths.manifest, "utf8"));
const status = () => readFileSync(paths.status, "utf8").split("\n");
/** Os comandos lançam InstallError (o main vira código de saída): aqui devolve o código. */
const code = (fn) => {
	try {
		return fn();
	} catch (error) {
		if (error instanceof InstallError) return error.code;
		throw error;
	}
};
const quiet = { out: () => undefined, err: () => undefined };

function makeInstaller(extra = {}) {
	return createInstaller({
		run: fake.run,
		lockFile,
		stateDir: join(root, "state"),
		aptLists: join(root, "lists"),
		trustedUid: uid,
		trustedGid: gid,
		now: () => clock,
		sleep: (ms) => {
			clock += ms;
		},
		...quiet,
		...extra,
	});
}

function writeDeb(name, body) {
	const file = join(paths.home, "work", name);
	writeFileSync(file, body);
	return file;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "atlas-install-cmd-"));
	const home = join(root, "home", "atlas");
	mkdirSync(join(home, "work"), { recursive: true });
	mkdirSync(join(root, "state"));
	mkdirSync(join(root, "lists"));
	writeFileSync(join(root, "lists", "deb.debian.org_Packages"), "x");
	writeFileSync(join(root, "state", "apt-updated"), "fresh"); // carimbo novo: sem apt-get update
	paths = atlasPaths(home);
	lockFile = join(root, "run.lock");
	fake = makeFake();
	clock = 1_000_000;
	inst = makeInstaller();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("cmdApt", () => {
	test("argv exato do apt-get (flags fixas, --no-remove, só os nomes validados) e registro", () => {
		assert.equal(inst.cmdApt({ action: "apt", packages: ["vlc", "htop"] }, paths), EXIT.OK);
		const [call] = installs();
		assert.equal(call.cmd, "/usr/bin/apt-get");
		assert.deepEqual(call.args, ["install", ...FLAGS, "vlc", "htop"]);
		assert.ok(call.args.includes("--no-remove"));
		for (const c of fake.calls) assert.ok(c.cmd.startsWith("/usr/"), `comando sem caminho absoluto: ${c.cmd}`);
		assert.deepEqual(manifest().apt.map((e) => e.name), ["vlc", "htop"]);
		assert.equal(existsSync(lockFile), false, "a trava foi liberada");
	});
	test("nome que não está exatamente no índice: 65, nada instalado, nada registrado", () => {
		assert.equal(code(() => inst.cmdApt({ action: "apt", packages: ["vlc", "naoexiste"] }, paths)), EXIT.BAD_INPUT);
		assert.equal(installs().length, 0);
		assert.equal(existsSync(paths.manifest), false);
	});
	test("apt-get falhou: sai com 1 e não registra", () => {
		fake.failInstallFor.add("vlc");
		assert.equal(code(() => code(() => inst.cmdApt({ action: "apt", packages: ["vlc"] }, paths))), EXIT.FAILED);
		assert.equal(existsSync(paths.manifest), false);
	});
});

describe("cmdDeb", () => {
	test("copia para debs/, instala pelo caminho do diretório verificado e registra", () => {
		const file = writeDeb("foo.deb", "conteudo-do-deb");
		assert.equal(code(() => code(() => inst.cmdDeb({ action: "deb", file }, paths))), EXIT.OK);
		const stored = storedDebName("foo", sha("conteudo-do-deb"));
		assert.ok(existsSync(join(paths.debs, stored)));
		const [call] = installs();
		assert.deepEqual(call.args.slice(0, 1 + FLAGS.length), ["install", ...FLAGS]);
		assert.match(call.args.at(-1), new RegExp(`^/proc/${process.pid}/fd/\\d+/${stored}$`));
		assert.deepEqual(manifest().debs.map((e) => [e.name, e.file, e.sha256]), [["foo", stored, sha("conteudo-do-deb")]]);
	});
	test("arquitetura errada ou arquivo que não é .deb: 65, nada instalado e nada sobra em debs/", () => {
		const file = writeDeb("foo.deb", "x");
		fake.debInfo = "Package: foo\nArchitecture: arm64\n";
		assert.equal(code(() => code(() => inst.cmdDeb({ action: "deb", file }, paths))), 65);
		fake.debInfoStatus = 2;
		assert.equal(code(() => code(() => inst.cmdDeb({ action: "deb", file }, paths))), 65);
		assert.equal(installs().length, 0);
		assert.deepEqual(readdirSync(paths.debs), []);
	});
	test("apt-get falhou: remove a cópia nova e não registra", () => {
		const file = writeDeb("foo.deb", "x");
		fake.failInstallFor.add("foo");
		assert.equal(code(() => code(() => inst.cmdDeb({ action: "deb", file }, paths))), EXIT.FAILED);
		assert.deepEqual(readdirSync(paths.debs), []);
		assert.equal(existsSync(paths.manifest), false);
	});
});

describe("o último instalado vence (mesmo pacote em apt e em deb)", () => {
	test("apt depois deb: sai a entrada apt", () => {
		inst.cmdApt({ action: "apt", packages: ["foo"] }, paths);
		assert.deepEqual(manifest().apt.map((e) => e.name), ["foo"]);
		inst.cmdDeb({ action: "deb", file: writeDeb("foo.deb", "v1") }, paths);
		assert.deepEqual(manifest().apt, []);
		assert.deepEqual(manifest().debs.map((e) => e.name), ["foo"]);
	});
	test("deb depois apt: sai a entrada deb e o arquivo órfão é apagado", () => {
		inst.cmdDeb({ action: "deb", file: writeDeb("foo.deb", "v1") }, paths);
		const stored = storedDebName("foo", sha("v1"));
		assert.ok(existsSync(join(paths.debs, stored)));
		inst.cmdApt({ action: "apt", packages: ["foo"] }, paths);
		assert.deepEqual(manifest().debs, []);
		assert.deepEqual(manifest().apt.map((e) => e.name), ["foo"]);
		assert.equal(existsSync(join(paths.debs, stored)), false);
	});
});

describe("cmdRemove", () => {
	test("pacote fora do registro: 65 e nenhum apt-get remove", () => {
		assert.equal(code(() => inst.cmdRemove({ action: "remove", package: "git" }, paths)), 65);
		assert.equal(fake.calls.filter((c) => c.args[0] === "remove").length, 0);
	});
	test("registrado: argv exato, sai do registro junto com o que o apt removeu", () => {
		inst.cmdApt({ action: "apt", packages: ["vlc", "htop"] }, paths);
		fake.removeAlso = ["htop"];
		assert.equal(inst.cmdRemove({ action: "remove", package: "vlc" }, paths), EXIT.OK);
		const call = fake.calls.find((c) => c.args[0] === "remove");
		assert.deepEqual(call.args, ["remove", "-y", "vlc"]);
		assert.deepEqual(manifest().apt, []);
	});
});

describe("prepare", () => {
	test("com pacotes grava 'pending' (quem muda para running é o reinstall); sem pacotes grava 'done'", () => {
		assert.equal(inst.cmdPrepare(paths), EXIT.OK);
		assert.equal(status()[0], "done");
		code(() => code(() => inst.cmdApt({ action: "apt", packages: ["vlc"] }, paths)));
		inst.cmdPrepare(paths);
		assert.equal(status()[0], "pending");
	});
});

describe("cmdReinstall com manifesto adulterado", () => {
	test("só o que passa na validação chega ao apt-get; .deb forjado falha; o válido volta pelo diretório verificado", () => {
		inst.cmdPrepare(paths);
		const body = "deb-valido";
		const stored = storedDebName("foo", sha(body));
		writeFileSync(join(paths.debs, stored), body);
		writeFileSync(
			paths.manifest,
			JSON.stringify({
				version: 1,
				apt: [{ name: "vlc" }, { name: "x; rm -rf /" }, { name: "-o" }, { name: "$(id)" }, { name: "git" }, { name: "naoexiste" }],
				debs: [
					{ name: "foo", file: stored, sha256: sha(body) },
					{ name: "fake", file: storedDebName("fake", sha("z")), sha256: sha("z") },
					{ name: "evil", file: "../../../etc/cron.d/x", sha256: sha("e") },
				],
			}),
		);
		assert.equal(inst.cmdReinstall(paths), EXIT.FAILED);
		const everyArg = installs().flatMap((c) => c.args.slice(1 + FLAGS.length));
		assert.ok(everyArg.includes("vlc"));
		assert.ok(everyArg.some((a) => a.endsWith(stored)));
		for (const arg of everyArg) {
			assert.doesNotMatch(arg, /rm -rf|\$\(|^-o$|evil|etc\/cron/);
			assert.ok(arg === "vlc" || arg.startsWith("/proc/"), `argumento inesperado: ${arg}`);
		}
		for (const call of installs()) assert.deepEqual(call.args.slice(0, 1 + FLAGS.length), ["install", ...FLAGS]);
		const lines = status();
		assert.equal(lines[0], "failed");
		assert.match(lines[2], /naoexiste \(not in the index\)/);
		assert.match(lines[2], /fake \(file missing\)/);
		assert.match(lines[2], /reinstalled: .*vlc/);
		assert.match(readFileSync(paths.log, "utf8"), /ignored: /);
	});
	test("nada faltando: done; lote que falha cai para um a um e só o ruim fica de fora", () => {
		inst.cmdApt({ action: "apt", packages: ["vlc", "htop"] }, paths);
		assert.equal(inst.cmdReinstall(paths), EXIT.OK);
		assert.equal(status()[0], "done");
		fake.installed.delete("vlc");
		fake.installed.delete("htop");
		fake.failInstallFor.add("htop");
		fake.calls.length = 0;
		assert.equal(inst.cmdReinstall(paths), EXIT.FAILED);
		assert.deepEqual(installs().map((c) => c.args.slice(1 + FLAGS.length)), [["vlc", "htop"], ["vlc"], ["htop"]]);
		assert.match(status()[2], /reinstalled: vlc; failed: htop \(exit 100\)/);
	});
});

describe("trava", () => {
	test("dono vivo: o comando espera e desiste com 75 (sem remover a trava alheia)", () => {
		writeFileSync(lockFile, String(process.ppid));
		assert.equal(code(() => code(() => inst.cmdApt({ action: "apt", packages: ["vlc"] }, paths))), EXIT.TEMP_FAIL);
		assert.equal(readFileSync(lockFile, "utf8"), String(process.ppid));
		assert.equal(installs().length, 0);
	});
	test("dono morto: a trava é retomada e liberada no fim; não sobra arquivo temporário", () => {
		writeFileSync(lockFile, String(spawnSync("true").pid));
		assert.equal(code(() => code(() => inst.cmdApt({ action: "apt", packages: ["vlc"] }, paths))), EXIT.OK);
		assert.equal(existsSync(lockFile), false);
		assert.deepEqual(readdirSync(root).filter((n) => n.includes(".tmp")), []);
	});
	test("só remove a trava no fim se ela ainda é a nossa", () => {
		inst.withLock(() => writeFileSync(lockFile, String(process.ppid)));
		assert.equal(readFileSync(lockFile, "utf8"), String(process.ppid));
	});
	test("reinstall espera o agente terminar de instalar (não vira failed) e só então roda", () => {
		code(() => code(() => inst.cmdApt({ action: "apt", packages: ["vlc"] }, paths)));
		fake.installed.delete("vlc");
		fake.calls.length = 0;
		writeFileSync(lockFile, String(process.ppid));
		let sleeps = 0;
		const waiting = makeInstaller({
			sleep: (ms) => {
				clock += ms;
				sleeps += 1;
				if (sleeps === 3) rmSync(lockFile); // o agente terminou
			},
		});
		assert.equal(waiting.cmdReinstall(paths), EXIT.OK);
		assert.ok(sleeps >= 3);
		assert.equal(status()[0], "done");
		assert.deepEqual(installs().map((c) => c.args.at(-1)), ["vlc"]);
	});
	test("reinstall só desiste depois de esperar muito mais que um comando do agente", () => {
		code(() => code(() => inst.cmdApt({ action: "apt", packages: ["vlc"] }, paths)));
		fake.installed.delete("vlc");
		writeFileSync(lockFile, String(process.ppid));
		const before = clock;
		assert.equal(inst.cmdReinstall(paths), EXIT.TEMP_FAIL);
		assert.ok(clock - before >= 10 * 60 * 1000);
		assert.equal(status()[0], "failed");
	});
});
