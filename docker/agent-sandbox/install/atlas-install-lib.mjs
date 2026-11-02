// Núcleo do `atlas-install`: validação de entrada, registro (manifesto) e checagens de confiança.
// Roda como ROOT dentro da VM, chamado pelo usuário `atlas` via sudo. Por isso tudo que vem do
// usuário (argumentos, caminhos) e tudo que vem do home dele (o manifesto, os .deb) é tratado
// como não confiável e validado ANTES de virar comando. Este módulo não executa nada: quem roda
// apt/dpkg é o cli.mjs. Assim a validação é testável sem root e sem rede.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Nome de pacote Debian aceito: minúsculo, sem espaço, sem `=` nem `/` (versão e release do apt). */
export const PKG_RE = /^[a-z0-9][a-z0-9+.-]{0,62}$/;
/** Quantos pacotes por chamada. */
export const MAX_PACKAGES = 10;
/** Teto de entradas no registro (apt + debs): protege o tempo da reinstalação. */
export const MAX_MANIFEST_ENTRIES = 200;
/** Teto do manifesto em disco. */
export const MAX_MANIFEST_BYTES = 1024 * 1024;
/** Teto de um .deb copiado. */
export const MAX_DEB_BYTES = 512 * 1024 * 1024;
/** Nome do .deb guardado: `<pacote>_<12 hex do sha256>.deb` (montado pelo script, nunca pelo usuário). */
export const DEB_FILE_RE = /^[a-z0-9][a-z0-9+.-]{0,62}_[0-9a-f]{12}\.deb$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;

/** Códigos de saída (sysexits): quem chama distingue "usei errado" de "o apt falhou". */
export const EXIT = {
	OK: 0,
	FAILED: 1,
	USAGE: 64,
	BAD_INPUT: 65,
	NO_INPUT: 66,
	UNAVAILABLE: 69,
	TEMP_FAIL: 75,
	NO_PERMISSION: 77,
};

export class InstallError extends Error {
	constructor(message, code = EXIT.BAD_INPUT) {
		super(message);
		this.name = "InstallError";
		this.code = code;
	}
}

/** Caminhos do registro a partir do home. Só o cli.mjs (root) escreve neles. */
export function atlasPaths(home = "/home/atlas") {
	const dir = path.join(home, ".atlas");
	return {
		home,
		dir,
		manifest: path.join(dir, "installed.json"),
		debs: path.join(dir, "debs"),
		log: path.join(dir, "install.log"),
		status: path.join(dir, "reinstall.status"),
	};
}

/** Devolve a mensagem de erro ou null se o nome é um pacote Debian aceitável. */
export function packageNameError(name) {
	if (typeof name !== "string") return "package name must be text";
	if (!PKG_RE.test(name)) {
		return `invalid package name ${JSON.stringify(name.slice(0, 80))}: use lowercase letters, digits, "+", "." and "-" (start with a letter or digit, max 63 chars). Options, versions (=), releases (/) and spaces are not accepted`;
	}
	// `foo-` significa "remover foo" para o apt-get; nunca é um nome de pacote.
	if (name.endsWith("-")) return `invalid package name ${JSON.stringify(name)}: must not end with "-"`;
	return null;
}

/**
 * Lê os argumentos (sem `node` nem o script) e devolve o pedido já validado.
 * `--dry-run` só valida e mostra o plano (usado nos testes e para o agente conferir).
 */
export function parseCommand(argv) {
	const args = [...argv];
	let dryRun = false;
	if (args[0] === "--dry-run") {
		dryRun = true;
		args.shift();
	}
	const action = args.shift();
	const usage = (message) => new InstallError(`${message}\n${USAGE}`, EXIT.USAGE);
	switch (action) {
		case "apt": {
			if (args.length === 0) throw usage("apt: tell me which packages to install");
			if (args.length > MAX_PACKAGES) throw new InstallError(`apt: at most ${MAX_PACKAGES} packages per call (got ${args.length}); split them`, EXIT.BAD_INPUT);
			for (const name of args) {
				const error = packageNameError(name);
				if (error) throw new InstallError(`apt: ${error}`, EXIT.BAD_INPUT);
			}
			return { action, dryRun, packages: [...new Set(args)] };
		}
		case "deb": {
			if (args.length !== 1) throw usage("deb: pass exactly one .deb file");
			return { action, dryRun, file: args[0] };
		}
		case "remove": {
			if (args.length !== 1) throw usage("remove: pass exactly one package");
			const error = packageNameError(args[0]);
			if (error) throw new InstallError(`remove: ${error}`, EXIT.BAD_INPUT);
			return { action, dryRun, package: args[0] };
		}
		case "list":
		case "prepare":
		case "reinstall": {
			if (args.length > 0) throw usage(`${action}: takes no arguments`);
			return { action, dryRun };
		}
		default:
			throw usage(action ? `unknown command ${JSON.stringify(String(action).slice(0, 40))}` : "missing command");
	}
}

export const USAGE = [
	"usage: sudo atlas-install apt <package...>   install Debian packages (max 10)",
	"       sudo atlas-install deb <file.deb>     install a .deb from your home (/home/atlas)",
	"       sudo atlas-install list               show what was installed",
	"       sudo atlas-install remove <package>   remove a package installed with atlas-install",
].join("\n");

function inside(child, root) {
	return child === root || child.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/**
 * Abre um .deb do usuário com segurança e devolve o descritor.
 * - Recusa `..` no texto, caminho fora do home (depois do realpath) e não-arquivo.
 * - Abre com O_NOFOLLOW e confere de novo, pelo /proc/self/fd, ONDE o arquivo aberto realmente está:
 *   se o usuário trocar um diretório por um link simbólico entre a checagem e a abertura, o fd
 *   aponta para fora do home e a cópia é recusada (sem corrida entre checar e usar).
 */
export function openDebFromHome(input, { home = "/home/atlas", cwd = process.cwd(), maxBytes = MAX_DEB_BYTES } = {}) {
	if (typeof input !== "string" || input.length === 0 || input.length > 4096 || input.includes("\0")) {
		throw new InstallError("deb: invalid file path", EXIT.BAD_INPUT);
	}
	if (input.split("/").includes("..")) throw new InstallError('deb: paths with ".." are not accepted; pass the real path', EXIT.BAD_INPUT);
	let homeReal;
	try {
		homeReal = fs.realpathSync(home);
	} catch {
		throw new InstallError(`deb: home ${home} not found`, EXIT.UNAVAILABLE);
	}
	let real;
	try {
		real = fs.realpathSync(path.resolve(cwd, input));
	} catch {
		throw new InstallError(`deb: file not found: ${input}`, EXIT.NO_INPUT);
	}
	if (!inside(real, homeReal) || real === homeReal) {
		throw new InstallError(`deb: the file must be inside ${home} (resolved to ${real}). Download it there first`, EXIT.BAD_INPUT);
	}
	if (!real.endsWith(".deb")) throw new InstallError("deb: the file name must end in .deb", EXIT.BAD_INPUT);
	let fd;
	try {
		fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	} catch {
		throw new InstallError(`deb: cannot open ${real}`, EXIT.NO_INPUT);
	}
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile()) throw new InstallError("deb: not a regular file", EXIT.BAD_INPUT);
		if (stat.size === 0) throw new InstallError("deb: the file is empty", EXIT.BAD_INPUT);
		if (stat.size > maxBytes) throw new InstallError(`deb: file too large (${stat.size} bytes, max ${maxBytes})`, EXIT.BAD_INPUT);
		let actual;
		try {
			actual = fs.readlinkSync(`/proc/self/fd/${fd}`);
		} catch {
			throw new InstallError("deb: cannot verify the opened file (/proc unavailable)", EXIT.UNAVAILABLE);
		}
		if (!inside(actual, homeReal)) throw new InstallError("deb: the file moved outside the home while opening; refusing", EXIT.BAD_INPUT);
		return { fd, size: stat.size, real };
	} catch (error) {
		fs.closeSync(fd);
		throw error;
	}
}

/** Copia do fd para `dest` (novo, 0644) calculando o sha256. Devolve o hash completo. */
export function copyFdWithHash(fd, dest, { maxBytes = MAX_DEB_BYTES } = {}) {
	const out = fs.openSync(dest, "wx", 0o644);
	const hash = createHash("sha256");
	const buffer = Buffer.allocUnsafe(1024 * 1024);
	let total = 0;
	try {
		for (;;) {
			const read = fs.readSync(fd, buffer, 0, buffer.length, null);
			if (read === 0) break;
			total += read;
			if (total > maxBytes) throw new InstallError("deb: file grew past the size limit while copying", EXIT.BAD_INPUT);
			hash.update(buffer.subarray(0, read));
			fs.writeSync(out, buffer, 0, read);
		}
	} catch (error) {
		fs.closeSync(out);
		fs.rmSync(dest, { force: true });
		throw error;
	}
	fs.closeSync(out);
	return hash.digest("hex");
}

export function sha256OfFile(file) {
	const hash = createHash("sha256");
	const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		const buffer = Buffer.allocUnsafe(1024 * 1024);
		for (;;) {
			const read = fs.readSync(fd, buffer, 0, buffer.length, null);
			if (read === 0) break;
			hash.update(buffer.subarray(0, read));
		}
	} finally {
		fs.closeSync(fd);
	}
	return hash.digest("hex");
}

/** Nome do .deb guardado, montado só de campos já validados. */
export function storedDebName(pkg, sha256) {
	const name = `${pkg}_${sha256.slice(0, 12)}.deb`;
	if (!DEB_FILE_RE.test(name)) throw new InstallError("deb: package name in the file is not acceptable", EXIT.BAD_INPUT);
	return name;
}

/**
 * Abre um diretório e só o devolve se for de `trustedUid` e sem escrita para grupo/outros.
 * O caminho devolvido (`/proc/self/fd/N`) aponta para o inode já verificado: mesmo que o
 * usuário renomeie o diretório depois, as escritas continuam indo para o diretório confiável.
 */
export function openTrustedDir(dirPath, { trustedUid = 0 } = {}) {
	let fd;
	try {
		fd = fs.openSync(dirPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
	} catch (error) {
		return { ok: false, reason: error.code === "ENOENT" ? "missing" : "untrusted" };
	}
	const stat = fs.fstatSync(fd);
	if (stat.uid !== trustedUid || (stat.mode & 0o022) !== 0) {
		fs.closeSync(fd);
		return { ok: false, reason: "untrusted" };
	}
	return { ok: true, fd, path: `/proc/self/fd/${fd}`, close: () => fs.closeSync(fd) };
}

/**
 * Garante `<home>/.atlas` de dono confiável (root em produção), modo 0755. O usuário `atlas` é
 * dono do próprio home e poderia pré-criar `.atlas` (ou um link simbólico) para enganar quem
 * escreve como root; o que não for confiável é movido de lado, nunca seguido nem reaproveitado.
 */
export function ensureTrustedAtlasDir(home, { trustedUid = 0, trustedGid = trustedUid } = {}) {
	const { dir } = atlasPaths(home);
	let quarantined = null;
	let stat = null;
	try {
		stat = fs.lstatSync(dir);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	if (stat && (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== trustedUid || (stat.mode & 0o022) !== 0)) {
		quarantined = `${dir}.untrusted-${Date.now()}`;
		fs.renameSync(dir, quarantined);
		stat = null;
	}
	if (!stat) {
		fs.mkdirSync(dir, { mode: 0o755 });
		if (process.getuid?.() === 0) fs.chownSync(dir, trustedUid, trustedGid);
		fs.chmodSync(dir, 0o755);
	}
	const trusted = openTrustedDir(dir, { trustedUid });
	if (!trusted.ok) throw new InstallError(`${dir} is not trustworthy (${trusted.reason}); try again`, EXIT.TEMP_FAIL);
	return { trusted, quarantined };
}

/** Abre `<dir>/debs` (criando) com a mesma regra de confiança, relativo ao diretório já aberto. */
export function ensureTrustedSubdir(parent, name, { trustedUid = 0, trustedGid = trustedUid } = {}) {
	const sub = `${parent.path}/${name}`;
	try {
		fs.mkdirSync(sub, { mode: 0o755 });
		if (process.getuid?.() === 0) fs.chownSync(sub, trustedUid, trustedGid);
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
	}
	const opened = openTrustedDir(sub, { trustedUid });
	if (!opened.ok) throw new InstallError(`${name} directory is not trustworthy (${opened.reason})`, EXIT.TEMP_FAIL);
	return opened;
}

/** Manifesto vazio. */
export function emptyManifest() {
	return { version: 1, apt: [], debs: [] };
}

function isoOrNow(value) {
	return typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value)) ? value : new Date(0).toISOString();
}

/**
 * Filtra o manifesto lido do disco. Nada daqui vira comando sem passar de novo pelas mesmas regras
 * da entrada do usuário: o atlas consegue editar o próprio home, então o arquivo pode ter sido
 * adulterado. Entrada inválida é descartada (e listada em `dropped`), nunca corrigida.
 */
export function sanitizeManifest(raw) {
	const manifest = emptyManifest();
	const dropped = [];
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { manifest, dropped: ["manifest is not an object"] };
	}
	const seen = new Set();
	let total = 0;
	const room = () => total < MAX_MANIFEST_ENTRIES;
	if (raw.apt !== undefined && !Array.isArray(raw.apt)) dropped.push("apt is not a list");
	for (const entry of Array.isArray(raw.apt) ? raw.apt : []) {
		const name = entry && typeof entry === "object" ? entry.name : undefined;
		const error = packageNameError(name);
		if (error) {
			dropped.push(`apt entry ${JSON.stringify(String(name).slice(0, 40))}: invalid name`);
			continue;
		}
		if (seen.has(name)) continue;
		if (!room()) {
			dropped.push(`apt entry ${name}: over the ${MAX_MANIFEST_ENTRIES}-entry limit`);
			continue;
		}
		seen.add(name);
		total += 1;
		manifest.apt.push({ name, installedAt: isoOrNow(entry.installedAt) });
	}
	if (raw.debs !== undefined && !Array.isArray(raw.debs)) dropped.push("debs is not a list");
	for (const entry of Array.isArray(raw.debs) ? raw.debs : []) {
		const e = entry && typeof entry === "object" ? entry : {};
		if (packageNameError(e.name) || typeof e.file !== "string" || !DEB_FILE_RE.test(e.file) || typeof e.sha256 !== "string" || !SHA256_RE.test(e.sha256)) {
			dropped.push(`deb entry ${JSON.stringify(String(e.name).slice(0, 40))}: invalid name, file or checksum`);
			continue;
		}
		// O nome do arquivo guardado é derivado do pacote e do hash: qualquer outra coisa é forjada.
		if (e.file !== storedDebName(e.name, e.sha256)) {
			dropped.push(`deb entry ${e.name}: file name does not match package and checksum`);
			continue;
		}
		if (seen.has(e.name)) continue;
		if (!room()) {
			dropped.push(`deb entry ${e.name}: over the ${MAX_MANIFEST_ENTRIES}-entry limit`);
			continue;
		}
		seen.add(e.name);
		total += 1;
		manifest.debs.push({ name: e.name, file: e.file, sha256: e.sha256, installedAt: isoOrNow(e.installedAt) });
	}
	return { manifest, dropped };
}

/** Lê e filtra o manifesto de um diretório confiável (arquivo ausente ou ilegível = vazio). */
export function readManifest(trustedDir, { trustedUid = 0 } = {}) {
	const file = `${trustedDir.path}/installed.json`;
	let stat;
	try {
		stat = fs.lstatSync(file);
	} catch {
		return { manifest: emptyManifest(), dropped: [] };
	}
	if (!stat.isFile() || stat.uid !== trustedUid || (stat.mode & 0o022) !== 0 || stat.size > MAX_MANIFEST_BYTES) {
		return { manifest: emptyManifest(), dropped: ["manifest file is not trustworthy; ignored"] };
	}
	let raw;
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return { manifest: emptyManifest(), dropped: ["manifest is not valid JSON; ignored"] };
	}
	return sanitizeManifest(raw);
}

/** Grava o manifesto (tmp + rename dentro do diretório confiável). */
export function writeManifest(trustedDir, manifest) {
	const tmp = `${trustedDir.path}/installed.json.tmp`;
	fs.rmSync(tmp, { force: true });
	fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644, flag: "wx" });
	fs.renameSync(tmp, `${trustedDir.path}/installed.json`);
}

/** Confere um .deb guardado antes de reinstalar: só em `debs/`, arquivo comum, dono confiável e hash igual. */
export function verifyStoredDeb(debsDir, entry, { trustedUid = 0 } = {}) {
	if (!DEB_FILE_RE.test(entry.file)) return "bad file name";
	const file = `${debsDir.path}/${entry.file}`;
	let stat;
	try {
		stat = fs.lstatSync(file);
	} catch {
		return "file missing";
	}
	if (!stat.isFile() || stat.uid !== trustedUid || (stat.mode & 0o022) !== 0) return "file is not trustworthy";
	if (stat.size > MAX_DEB_BYTES) return "file too large";
	let sum;
	try {
		sum = sha256OfFile(file);
	} catch {
		return "cannot read file";
	}
	return sum === entry.sha256 ? null : "checksum mismatch";
}

/** Saída de `dpkg-query -W -f '${Package} ${db:Status-Abbrev}\n'` → conjunto de instalados ("ii"). */
export function parseInstalled(output) {
	const installed = new Set();
	for (const line of String(output).split("\n")) {
		const match = /^(\S+) ii\s*$/.exec(line.trimEnd());
		if (match) installed.add(match[1].split(":")[0]);
	}
	return installed;
}

/** O que falta reinstalar, dado o manifesto já filtrado e o que o dpkg diz estar instalado. */
export function planReinstall(manifest, installed) {
	return {
		apt: manifest.apt.filter((entry) => !installed.has(entry.name)).map((entry) => entry.name),
		debs: manifest.debs.filter((entry) => !installed.has(entry.name)),
	};
}

/** `apt-get update` só se faltar índice ou o carimbo estiver velho. */
export function needsAptUpdate({ listsCount, stampMtimeMs, now, maxAgeMs = 6 * 60 * 60 * 1000 }) {
	if (!listsCount) return true;
	if (typeof stampMtimeMs !== "number") return true;
	return now - stampMtimeMs > maxAgeMs;
}

/** `Package`/`Architecture` de `dpkg-deb -f arquivo Package Architecture`. */
export function parseDebFields(output) {
	const fields = {};
	for (const line of String(output).split("\n")) {
		const match = /^(Package|Architecture): (\S+)\s*$/.exec(line);
		if (match) fields[match[1]] = match[2];
	}
	return fields;
}
