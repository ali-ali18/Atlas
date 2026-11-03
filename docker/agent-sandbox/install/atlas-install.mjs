// atlas-install: o único caminho para o usuário `atlas` instalar programas como root na VM.
// Chamado por `sudo atlas-install ...` (sudoers libera só este wrapper) e pelo entrypoint
// (`prepare` e `reinstall`, como root). Cada pedido é validado por atlas-install-lib.mjs ANTES de
// qualquer comando rodar como root; apt e dpkg são chamados com argv fixo (sem shell), ambiente
// limpo e sem opções vindas do usuário. Ver docs/features/vm-instalacoes.md.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
	atlasPaths,
	copyFdWithHash,
	EXIT,
	ensureTrustedAtlasDir,
	ensureTrustedSubdir,
	InstallError,
	MAX_DEB_BYTES,
	needsAptUpdate,
	openDebFromHome,
	parseCommand,
	parseDebFields,
	parseInstalled,
	planReinstall,
	PKG_RE,
	readManifest,
	storedDebName,
	verifyStoredDeb,
	writeManifest,
} from "./atlas-install-lib.mjs";

/** Teto da reinstalação ao ligar a VM. Passou disso: status `failed` e o agente é avisado pelo arquivo. */
export const REINSTALL_BUDGET_MS = 15 * 60 * 1000;
/** Teto de uma instalação pedida pelo agente (o passo de shell em primeiro plano já expira antes: use background). */
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;
/** Quanto o `reinstall` espera um `sudo atlas-install` do agente terminar antes de desistir (não vira `failed` à toa). */
export const REINSTALL_LOCK_WAIT_MS = 10 * 60 * 1000;
const DEFAULTS = {
	lockFile: "/run/atlas-install.lock",
	stateDir: "/var/lib/atlas-install",
	aptLists: "/var/lib/apt/lists",
	trustedUid: 0,
	trustedGid: 0,
};
const TOTAL_DEBS_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const LOG_MAX_BYTES = 1024 * 1024;

/** Ambiente do apt/dpkg: nada herdado (APT_CONFIG, LD_PRELOAD, PATH do usuário...). */
const CLEAN_ENV = Object.freeze({
	PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
	DEBIAN_FRONTEND: "noninteractive",
	DEBCONF_NONINTERACTIVE_SEEN: "true",
	APT_LISTCHANGES_FRONTEND: "none",
	NEEDRESTART_MODE: "a",
	LANG: "C.UTF-8",
	LC_ALL: "C.UTF-8",
	HOME: "/root",
});
const APT_INSTALL_FLAGS = [
	"-y",
	"--no-install-recommends",
	// Nunca remove nada para instalar (não derruba sudo, node ou o desktop por um conflito).
	"--no-remove",
	"-o",
	"Dpkg::Options::=--force-confold",
	"-o",
	"Dpkg::Options::=--force-confdef",
];

const out = (message) => process.stdout.write(`${message}\n`);
const err = (message) => process.stderr.write(`${message}\n`);
const baseOut = out;
const baseErr = err;

function defaultRun(command, args, { timeoutMs = INSTALL_TIMEOUT_MS, capture = false, logFd = null } = {}) {
	const result = spawnSync(command, args, {
		env: CLEAN_ENV,
		encoding: "utf8",
		timeout: timeoutMs,
		killSignal: "SIGTERM",
		maxBuffer: 16 * 1024 * 1024,
		stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", logFd ?? "inherit", logFd ?? "inherit"],
	});
	return {
		status: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		timedOut: result.error?.code === "ETIMEDOUT",
	};
}

function defaultSleep(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Os comandos, com tudo que toca o sistema injetável (`run` = spawn de apt/dpkg, caminhos de trava e
 * índice, dono confiável, `sleep`): os testes exercitam os comandos de verdade com um apt falso.
 */
export function createInstaller(overrides = {}) {
const o = { run: defaultRun, sleep: defaultSleep, pid: process.pid, ...DEFAULTS, ...overrides };
const { run, sleep } = o;
const now = o.now ?? Date.now;
const out = o.out ?? baseOut;
const err = o.err ?? baseErr;
const LOCK_FILE = o.lockFile;
const STATE_DIR = o.stateDir;
const UPDATE_STAMP = `${STATE_DIR}/apt-updated`;
const APT_LISTS = o.aptLists;
const trust = { trustedUid: o.trustedUid, trustedGid: o.trustedGid };

function pidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}

function readLockHolder() {
	try {
		return Number.parseInt(fs.readFileSync(LOCK_FILE, "utf8"), 10) || 0;
	} catch {
		return 0;
	}
}

/** Cria a trava de forma atômica: o arquivo nasce já com o pid (link de um temporário), nunca vazio. */
function tryCreateLock() {
	const tmp = `${LOCK_FILE}.${o.pid}.tmp`;
	fs.writeFileSync(tmp, String(o.pid), { mode: 0o600 });
	try {
		fs.linkSync(tmp, LOCK_FILE);
		return true;
	} catch (error) {
		if (error.code === "EEXIST") return false;
		throw error;
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}

/**
 * Uma instalação por vez (o manifesto é lido, alterado e gravado; o apt já tem a trava dele).
 * Dono morto: só remove se o arquivo AINDA tem o mesmo pid morto na hora de remover (quem chegou
 * depois e criou a sua não é apagado); ao sair só remove a trava se ela continua sendo a nossa.
 */
function withLock(fn, { waitMs = 30_000 } = {}) {
	const start = now();
	for (;;) {
		if (tryCreateLock()) break;
		const holder = readLockHolder();
		if (holder === 0) continue; // sumiu entre o link e a leitura
		if (holder !== o.pid && !pidAlive(holder)) {
			if (readLockHolder() === holder) fs.rmSync(LOCK_FILE, { force: true });
			continue;
		}
		if (now() - start > waitMs) {
			throw new InstallError("another install is running (for example the automatic reinstall after the VM started). Check ~/.atlas/reinstall.status and try again in a minute", EXIT.TEMP_FAIL);
		}
		sleep(500);
	}
	try {
		return fn();
	} finally {
		if (readLockHolder() === o.pid) fs.rmSync(LOCK_FILE, { force: true });
	}
}

function installedSet() {
	const result = run("/usr/bin/dpkg-query", ["-W", "-f", "${Package} ${db:Status-Abbrev}\\n"], { capture: true, timeoutMs: 60_000 });
	return parseInstalled(result.stdout);
}

function listsCount() {
	try {
		return fs.readdirSync(APT_LISTS).filter((name) => /_Packages(\.|$)/.test(name)).length;
	} catch {
		return 0;
	}
}

/** apt-get update só quando falta índice ou o carimbo passou de 6 h. Falha com índice antigo segue com aviso. */
function aptUpdateIfNeeded({ timeoutMs, logFd = null }) {
	let stampMtimeMs;
	try {
		stampMtimeMs = fs.statSync(UPDATE_STAMP).mtimeMs;
	} catch {
		/* sem carimbo */
	}
	const count = listsCount();
	if (!needsAptUpdate({ listsCount: count, stampMtimeMs, now: now() })) return;
	out("Updating the package index (apt-get update)...");
	const result = run("/usr/bin/apt-get", ["update"], { timeoutMs, logFd });
	if (result.status !== 0) {
		if (count === 0) {
			throw new InstallError(
				result.timedOut ? "apt-get update timed out" : "apt-get update failed and there is no package index. Check the network (no internet = no apt); a .deb you already downloaded can still be installed with `sudo atlas-install deb`",
				EXIT.FAILED,
			);
		}
		err("warning: apt-get update failed; continuing with the old package index");
		return;
	}
	fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o755 });
	fs.writeFileSync(UPDATE_STAMP, `${new Date().toISOString()}\n`);
}

/** Nome exato de pacote real (o apt trataria `a.+` como regex e instalaria dezenas de pacotes). */
function packageExists(name) {
	const result = run("/usr/bin/apt-cache", ["pkgnames", name], { capture: true, timeoutMs: 60_000 });
	return result.stdout.split("\n").includes(name);
}

function openLog(trusted) {
	const file = `${trusted.path}/install.log`;
	try {
		if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, `${trusted.path}/install.log.1`);
	} catch {
		/* sem log ainda */
	}
	return fs.openSync(file, "a", 0o644);
}

function logLine(fd, message) {
	fs.writeSync(fd, `[${new Date().toISOString()}] ${message}\n`);
}

function setStatus(trusted, state, detail = "") {
	const tmp = `${trusted.path}/reinstall.status.tmp`;
	fs.rmSync(tmp, { force: true });
	fs.writeFileSync(tmp, `${state}\n${new Date().toISOString()}\n${detail}\n`, { mode: 0o644, flag: "wx" });
	fs.renameSync(tmp, `${trusted.path}/reinstall.status`);
}

function readStatusState(trusted) {
	try {
		return fs.readFileSync(`${trusted.path}/reinstall.status`, "utf8").split("\n")[0] || "unknown";
	} catch {
		return null;
	}
}

function openState(paths) {
	const { trusted } = ensureTrustedAtlasDir(paths.home, trust);
	const debs = ensureTrustedSubdir(trusted, "debs", trust);
	return { trusted, debs };
}

function closeState(state) {
	state.debs.close();
	state.trusted.close();
}

/** Caminho do .deb guardado pelo diretório já verificado (o apt é processo filho: /proc/<nosso pid>/fd/N). */
function storedDebArg(debs, file) {
	return `/proc/${o.pid}/fd/${debs.fd}/${file}`;
}

// ---------------------------------------------------------------------------------------------

function cmdApt(cmd, paths) {
	return withLock(() => {
		const state = openState(paths);
		try {
			aptUpdateIfNeeded({ timeoutMs: 10 * 60 * 1000 });
			const missing = cmd.packages.filter((name) => !packageExists(name));
			if (missing.length) {
				throw new InstallError(
					`not found in the package index: ${missing.join(", ")}. Check the spelling; search with \`apt-cache search <word>\` (no sudo needed). Nothing was installed`,
					EXIT.BAD_INPUT,
				);
			}
			run("/usr/bin/dpkg", ["--configure", "-a", "--force-confold"], { timeoutMs: 5 * 60 * 1000 });
			out(`Installing: ${cmd.packages.join(" ")}`);
			const result = run("/usr/bin/apt-get", ["install", ...APT_INSTALL_FLAGS, ...cmd.packages]);
			if (result.status !== 0) {
				throw new InstallError(result.timedOut ? "install timed out; run it again in the background (background:true)" : `apt-get install failed (exit ${result.status}); see the output above. Nothing was registered`, EXIT.FAILED);
			}
			const installed = installedSet();
			const { manifest } = readManifest(state.trusted, trust);
			const now = new Date().toISOString();
			const done = [];
			for (const name of cmd.packages) {
				if (!installed.has(name)) continue;
				done.push(name);
				if (!manifest.apt.some((entry) => entry.name === name)) manifest.apt.push({ name, installedAt: now });
				// O último instalado vence: o mesmo pacote não fica em apt e em deb ao mesmo tempo.
				for (const stale of manifest.debs.filter((entry) => entry.name === name)) fs.rmSync(`${state.debs.path}/${stale.file}`, { force: true });
				manifest.debs = manifest.debs.filter((entry) => entry.name !== name);
			}
			writeManifest(state.trusted, manifest);
			out(`OK: installed ${done.join(", ")}. Registered in ${paths.manifest}; if the VM is recreated they are installed again automatically (see ~/.atlas/reinstall.status).`);
			return EXIT.OK;
		} finally {
			closeState(state);
		}
	});
}

function debsDirBytes(debs) {
	let total = 0;
	for (const name of fs.readdirSync(debs.path)) {
		try {
			total += fs.lstatSync(`${debs.path}/${name}`).size;
		} catch {
			/* sumiu */
		}
	}
	return total;
}

function cmdDeb(cmd, paths) {
	// Valida e abre o arquivo ANTES de pegar a trava ou tocar em algo como root.
	const opened = openDebFromHome(cmd.file, { home: paths.home });
	return withLock(() => {
		const state = openState(paths);
		let tmp = null;
		try {
			if (debsDirBytes(state.debs) + opened.size > TOTAL_DEBS_MAX_BYTES) {
				throw new InstallError("too many .deb files stored already (2 GiB). Remove something with `sudo atlas-install remove <package>`", EXIT.BAD_INPUT);
			}
			tmp = `${state.debs.path}/incoming-${process.pid}.tmp`;
			fs.rmSync(tmp, { force: true });
			const sha256 = copyFdWithHash(opened.fd, tmp, { maxBytes: MAX_DEB_BYTES });
			const info = run("/usr/bin/dpkg-deb", ["-f", tmp, "Package", "Architecture"], { capture: true, timeoutMs: 60_000 });
			const fields = parseDebFields(info.stdout);
			if (info.status !== 0 || !fields.Package) throw new InstallError("deb: this is not a valid Debian package (dpkg-deb could not read it)", EXIT.BAD_INPUT);
			if (!PKG_RE.test(fields.Package)) throw new InstallError(`deb: package name ${JSON.stringify(fields.Package.slice(0, 60))} is not acceptable`, EXIT.BAD_INPUT);
			const arch = run("/usr/bin/dpkg", ["--print-architecture"], { capture: true, timeoutMs: 30_000 }).stdout.trim();
			if (fields.Architecture !== "all" && fields.Architecture !== arch) {
				throw new InstallError(`deb: built for ${fields.Architecture}, this VM is ${arch}. Look for the ${arch} (or "all") build, or use another install method`, EXIT.BAD_INPUT);
			}
			const finalName = storedDebName(fields.Package, sha256);
			fs.renameSync(tmp, `${state.debs.path}/${finalName}`);
			tmp = null;
			aptUpdateIfNeeded({ timeoutMs: 10 * 60 * 1000 });
			run("/usr/bin/dpkg", ["--configure", "-a", "--force-confold"], { timeoutMs: 5 * 60 * 1000 });
			out(`Installing ${fields.Package} from ${opened.real}`);
			// Caminho absoluto: o apt só trata como arquivo o que começa com ./ ou /.
			const result = run("/usr/bin/apt-get", ["install", ...APT_INSTALL_FLAGS, storedDebArg(state.debs, finalName)]);
			const { manifest } = readManifest(state.trusted, trust);
			if (result.status !== 0) {
				if (!manifest.debs.some((entry) => entry.file === finalName)) fs.rmSync(`${state.debs.path}/${finalName}`, { force: true });
				throw new InstallError(result.timedOut ? "install timed out; run it again in the background (background:true)" : `apt-get install failed (exit ${result.status}); see the output above. Nothing was registered`, EXIT.FAILED);
			}
			for (const old of manifest.debs.filter((entry) => entry.name === fields.Package && entry.file !== finalName)) {
				fs.rmSync(`${state.debs.path}/${old.file}`, { force: true });
			}
			manifest.debs = manifest.debs.filter((entry) => entry.name !== fields.Package);
			// O último instalado vence: a entrada apt do mesmo nome sai (senão a reinstalação trocaria o .deb pelo do repositório).
			manifest.apt = manifest.apt.filter((entry) => entry.name !== fields.Package);
			manifest.debs.push({ name: fields.Package, file: finalName, sha256, installedAt: new Date().toISOString() });
			writeManifest(state.trusted, manifest);
			out(`OK: installed ${fields.Package}. The .deb is kept in ${paths.debs} and is installed again automatically if the VM is recreated.`);
			return EXIT.OK;
		} finally {
			if (tmp) fs.rmSync(tmp, { force: true });
			closeState(state);
			fs.closeSync(opened.fd);
		}
	});
}

function cmdList(paths) {
	const { trusted } = ensureTrustedAtlasDir(paths.home, trust);
	try {
		const { manifest, dropped } = readManifest(trusted, trust);
		const installed = installedSet();
		const rows = [
			...manifest.apt.map((entry) => ({ kind: "apt", name: entry.name, at: entry.installedAt })),
			...manifest.debs.map((entry) => ({ kind: "deb", name: entry.name, at: entry.installedAt })),
		];
		out(rows.length ? `Installed with atlas-install (${rows.length}):` : "Nothing was installed with atlas-install yet.");
		for (const row of rows) {
			out(`  ${row.kind}  ${row.name.padEnd(28)} ${row.at.slice(0, 10)}  ${installed.has(row.name) ? "installed" : "not installed yet (waiting for the reinstall)"}`);
		}
		const state = readStatusState(trusted);
		if (state) out(`Reinstall status: ${state} (details: ~/.atlas/reinstall.status, log: ~/.atlas/install.log)`);
		for (const note of dropped) out(`ignored: ${note}`);
		return EXIT.OK;
	} finally {
		trusted.close();
	}
}

function cmdRemove(cmd, paths) {
	return withLock(() => {
		const state = openState(paths);
		try {
			const { manifest } = readManifest(state.trusted, trust);
			const aptEntry = manifest.apt.find((entry) => entry.name === cmd.package);
			const debEntry = manifest.debs.find((entry) => entry.name === cmd.package);
			if (!aptEntry && !debEntry) {
				throw new InstallError(`${cmd.package} is not in the atlas-install registry. Only packages installed with \`sudo atlas-install\` can be removed (see \`sudo atlas-install list\`)`, EXIT.BAD_INPUT);
			}
			const before = installedSet();
			const result = run("/usr/bin/apt-get", ["remove", "-y", cmd.package]);
			if (result.status !== 0) throw new InstallError(`apt-get remove failed (exit ${result.status}); see the output above. The registry was not changed`, EXIT.FAILED);
			const after = installedSet();
			// Sai do registro o pedido e o que o apt removeu junto (dependentes), para não voltar na reinstalação.
			const gone = (name) => name === cmd.package || (before.has(name) && !after.has(name));
			for (const entry of manifest.debs.filter((e) => gone(e.name))) fs.rmSync(`${state.debs.path}/${entry.file}`, { force: true });
			manifest.apt = manifest.apt.filter((entry) => !gone(entry.name));
			manifest.debs = manifest.debs.filter((entry) => !gone(entry.name));
			writeManifest(state.trusted, manifest);
			out(`OK: removed ${cmd.package} and took it out of the registry.`);
			return EXIT.OK;
		} finally {
			closeState(state);
		}
	});
}

/** Entrypoint, antes de liberar o agente: deixa `.atlas` confiável e decide o status inicial. Rápido, sem rede. */
function cmdPrepare(paths) {
	fs.rmSync(LOCK_FILE, { force: true });
	const { trusted, quarantined } = ensureTrustedAtlasDir(paths.home, trust);
	const debs = ensureTrustedSubdir(trusted, "debs", trust);
	try {
		const { manifest } = readManifest(trusted, trust);
		const pending = manifest.apt.length + manifest.debs.length;
		if (quarantined) fs.writeFileSync(`${trusted.path}/install.log`, `[${new Date().toISOString()}] moved an untrustworthy .atlas to ${path.basename(quarantined)}; the registry was reset\n`, { mode: 0o644 });
		// `pending` (não `running`): quem muda para running é o reinstall, quando de fato começa.
		setStatus(trusted, pending ? "pending" : "done", pending ? `will reinstall ${pending} package(s) in the background` : "nothing to reinstall");
		out(`prepared ${paths.dir} (${pending} registered package(s))`);
		return EXIT.OK;
	} finally {
		debs.close();
		trusted.close();
	}
}

/** Entrypoint, em segundo plano: reinstala o que o registro lista e o dpkg não tem. Nunca bloqueia a VM. */
function cmdReinstall(paths) {
	let deadline = Infinity;
	const left = () => Math.max(1000, deadline - now());
	const expired = () => now() >= deadline;
	let state;
	try {
		state = openState(paths);
	} catch (error) {
		err(`reinstall: ${error.message}`);
		return EXIT.TEMP_FAIL;
	}
	const logFd = openLog(state.trusted);
	try {
		setStatus(state.trusted, "pending", "waiting for the package manager lock");
		return withLock(
			() => {
				// O relógio de 15 min só começa depois da trava: esperar o agente terminar uma instalação não gasta o orçamento.
				deadline = now() + REINSTALL_BUDGET_MS;
				setStatus(state.trusted, "running", "checking what is missing");
				const { manifest, dropped } = readManifest(state.trusted, trust);
				for (const note of dropped) logLine(logFd, `ignored: ${note}`);
				const plan = planReinstall(manifest, installedSet());
				const total = plan.apt.length + plan.debs.length;
				if (total === 0) {
					setStatus(state.trusted, "done", "nothing to reinstall");
					logLine(logFd, "reinstall: nothing missing");
					return EXIT.OK;
				}
				logLine(logFd, `reinstall: ${plan.apt.length} apt package(s), ${plan.debs.length} .deb file(s) missing`);
				setStatus(state.trusted, "running", `reinstalling ${total} package(s) (limit ${REINSTALL_BUDGET_MS / 60000} min)`);
				const failed = [];
				const okNames = [];
				try {
					aptUpdateIfNeeded({ timeoutMs: left(), logFd });
				} catch (error) {
					logLine(logFd, `update failed: ${error.message}`);
					setStatus(state.trusted, "failed", `could not update the package index: ${error.message}`);
					return EXIT.FAILED;
				}
				// Revalida cada nome do registro com as mesmas regras da entrada do usuário (planReinstall já usa o manifesto filtrado).
				const aptNames = plan.apt.filter((name) => PKG_RE.test(name) && packageExists(name));
				for (const name of plan.apt.filter((n) => !aptNames.includes(n))) failed.push(`${name} (not in the index)`);
				const install = (names, label) => {
					if (!names.length) return;
					if (expired()) {
						failed.push(...names.map((n) => `${label(n)} (time limit)`));
						return;
					}
					run("/usr/bin/dpkg", ["--configure", "-a", "--force-confold"], { timeoutMs: left(), logFd });
					const bulk = run("/usr/bin/apt-get", ["install", ...APT_INSTALL_FLAGS, ...names.map((n) => n.arg)], { timeoutMs: left(), logFd });
					if (bulk.status === 0) {
						okNames.push(...names.map(label));
						return;
					}
					// Um pacote ruim não pode travar os outros: tenta um a um.
					for (const item of names) {
						if (expired()) {
							failed.push(`${label(item)} (time limit)`);
							continue;
						}
						const single = run("/usr/bin/apt-get", ["install", ...APT_INSTALL_FLAGS, item.arg], { timeoutMs: left(), logFd });
						if (single.status === 0) okNames.push(label(item));
						else failed.push(`${label(item)} (${single.timedOut ? "time limit" : `exit ${single.status}`})`);
					}
				};
				install(aptNames.map((name) => ({ name, arg: name })), (n) => n.name);
				const debItems = [];
				for (const entry of plan.debs) {
					const problem = verifyStoredDeb(state.debs, entry, trust);
					if (problem) {
						failed.push(`${entry.name} (${problem})`);
						continue;
					}
					debItems.push({ name: entry.name, arg: storedDebArg(state.debs, entry.file) });
				}
				install(debItems, (n) => n.name);
				logLine(logFd, `reinstall: ok=[${okNames.join(", ")}] failed=[${failed.join(", ")}]`);
				if (failed.length) {
					setStatus(state.trusted, "failed", `reinstalled: ${okNames.join(", ") || "none"}; failed: ${failed.join(", ")}. Ask the user before trying again, or run sudo atlas-install apt <package>`);
					return EXIT.FAILED;
				}
				setStatus(state.trusted, "done", `reinstalled: ${okNames.join(", ")}`);
				return EXIT.OK;
			},
			{ waitMs: REINSTALL_LOCK_WAIT_MS },
		);
	} catch (error) {
		try {
			logLine(logFd, `reinstall error: ${error.message}`);
			setStatus(state.trusted, "failed", error.message);
		} catch {
			/* sem como gravar */
		}
		return error instanceof InstallError ? error.code : EXIT.FAILED;
	} finally {
		fs.closeSync(logFd);
		closeState(state);
	}
}

return { cmdApt, cmdDeb, cmdList, cmdRemove, cmdPrepare, cmdReinstall, withLock };
}

/** Valida e mostra o plano, sem tocar em nada. `ATLAS_INSTALL_HOME` só vale aqui, nunca em modo real. */
function cmdDryRun(cmd) {
	const home = process.env.ATLAS_INSTALL_HOME || "/home/atlas";
	switch (cmd.action) {
		case "apt":
			out(`dry-run: would install apt packages: ${cmd.packages.join(" ")}`);
			break;
		case "deb": {
			const opened = openDebFromHome(cmd.file, { home });
			fs.closeSync(opened.fd);
			out(`dry-run: would install ${opened.real} (${opened.size} bytes)`);
			break;
		}
		case "remove":
			out(`dry-run: would remove ${cmd.package}`);
			break;
		default:
			out(`dry-run: would run ${cmd.action}`);
	}
	return EXIT.OK;
}

export function main(argv, { uid = process.getuid?.() ?? -1, env = process.env } = {}) {
	try {
		const cmd = parseCommand(argv);
		if (cmd.dryRun) return cmdDryRun(cmd);
		if (uid !== 0) throw new InstallError("atlas-install must run as root: use `sudo atlas-install ...`", EXIT.NO_PERMISSION);
		if ((cmd.action === "prepare" || cmd.action === "reinstall") && env.SUDO_USER) {
			throw new InstallError(`${cmd.action} is internal (the VM runs it at startup)`, EXIT.NO_PERMISSION);
		}
		// O agente pode perder o terminal (timeout do passo de shell): termina a instalação e o registro mesmo assim.
		process.on("SIGHUP", () => {});
		process.on("SIGPIPE", () => {});
		const paths = atlasPaths("/home/atlas");
		const installer = createInstaller();
		switch (cmd.action) {
			case "apt":
				return installer.cmdApt(cmd, paths);
			case "deb":
				return installer.cmdDeb(cmd, paths);
			case "list":
				return installer.cmdList(paths);
			case "remove":
				return installer.cmdRemove(cmd, paths);
			case "prepare":
				return installer.cmdPrepare(paths);
			case "reinstall":
				return installer.cmdReinstall(paths);
			default:
				throw new InstallError("unknown command", EXIT.USAGE);
		}
	} catch (error) {
		if (error instanceof InstallError) {
			err(`atlas-install: ${error.message}`);
			return error.code;
		}
		err(`atlas-install: unexpected error: ${error?.message ?? error}`);
		return EXIT.FAILED;
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	process.exitCode = main(process.argv.slice(2));
}
