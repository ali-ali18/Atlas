/**
 * Peças puras de `video_transcript` (legenda de vídeo lida DENTRO da VM): idiomas pedidos, escolha do arquivo,
 * comandos de shell (yt-dlp e o fallback do YouTube) e a paginação por caracteres. Sem I/O: o legado
 * (`agent-runtime`) e o tratador `video.transcript` do v4 (worker) usam as mesmas peças.
 */

export const VIDEO_TRANSCRIPT_DEFAULT_LIMIT = 12_000;
export const VIDEO_TRANSCRIPT_MAX_LIMIT = 30_000;
export const VIDEO_SUBTITLE_DIR = "/home/atlas/work/.transcripts";

const YOUTUBE_HOSTS = ["youtube.com", "youtu.be", "youtube-nocookie.com"];

/** Aspas simples seguras para bash (`'` vira `'\''`). */
export function shq(value: string): string {
	return `'${value.split("'").join(`'\\''`)}'`;
}

export function isYoutubeUrl(url: string): boolean {
	const host = new URL(url).hostname.toLowerCase();
	return YOUTUBE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** Idiomas pedidos ao yt-dlp, em ordem de preferência (a base do idioma e o `-orig` do original entram junto). */
export function captionLanguages(lang: string | undefined): string[] {
	const out: string[] = [];
	const add = (code: string) => {
		if (!out.includes(code)) out.push(code);
	};
	if (lang) {
		add(lang);
		add(`${lang}-orig`);
		const base = lang.split("-")[0] ?? lang;
		add(base);
		add(`${base}-orig`);
	}
	for (const code of ["en", "pt", "es"]) {
		add(code);
		add(`${code}-orig`);
	}
	return out;
}

/** Cada arquivo `sub.<idioma>.vtt` ganha a posição do idioma na lista de preferência (o primeiro vence). */
export function pickCaptionFile(files: readonly string[], languages: readonly string[]): string | undefined {
	const rank = (file: string) => {
		const code = file.replace(/^sub\./, "").replace(/\.vtt$/, "");
		const i = languages.indexOf(code);
		return i < 0 ? languages.length : i;
	};
	return [...files].filter((f) => f.endsWith(".vtt")).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0];
}

export type TranscriptPage = { offset: number; end: number; total: number; text: string; done: boolean };

/** Uma página do texto. `offset` além do fim é erro (nunca página vazia calada). */
export function sliceTranscript(text: string, offset: number, limit: number): TranscriptPage {
	const total = text.length;
	if (offset >= total) throw new Error(`offset ${offset} is past the end of the transcript (${total} characters). Use an offset below ${total}.`);
	const end = Math.min(total, offset + limit);
	return { offset, end, total, text: text.slice(offset, end), done: end >= total };
}

/**
 * Proxy de saída guardado da VM (`docker/agent-sandbox/control/egress-proxy.mjs`): resolve o nome UMA vez e recusa IP interno, de
 * loopback ou de metadata. Só o Chromium saía por ele; o shell (yt-dlp, node) saía direto e seguia redirecionamento para a rede
 * interna. A porta vem do ambiente da VM (`SANDBOX_EGRESS_PROXY_PORT`), padrão 3128.
 */
const EGRESS_PROXY_URL = "http://127.0.0.1:${SANDBOX_EGRESS_PROXY_PORT:-3128}";

export function ytDlpCommand(dir: string, url: string, languages: readonly string[]): string {
	return [
		`mkdir -p ${shq(dir)} && cd ${shq(dir)} || exit 2`,
		// Já baixada neste vídeo e idioma (página seguinte do texto): não baixa de novo.
		`if ! ls ./*.vtt >/dev/null 2>&1; then`,
		`  command -v yt-dlp >/dev/null 2>&1 || { echo "yt-dlp: command not found" >&2; exit 127; }`,
		`  yt-dlp --proxy "${EGRESS_PROXY_URL}" --no-playlist --skip-download --write-subs --write-auto-subs --sub-langs ${shq(languages.join(","))} --sub-format vtt --no-warnings --no-progress -o 'sub.%(ext)s' -- ${shq(url)} 2>&1 | tail -n 8 >&2`,
		`fi`,
		`ls -1 ./*.vtt 2>/dev/null | sed 's#^\\./##'`,
	].join("\n");
}

/** Só no YouTube: lê `captionTracks` do `ytInitialPlayerResponse` da página e baixa a faixa como VTT. */
export const CAPTION_TRACKS_SCRIPT = String.raw`
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const headers = { "user-agent": UA, "accept-language": "en-US,en;q=0.9", cookie: "CONSENT=YES+1" };
const fail = (code, msg) => { console.error(msg); process.exit(code); };
const page = await fetch(process.env.VT_URL, { headers });
const html = await page.text();
const marker = '"captionTracks":';
const at = html.indexOf(marker);
if (at < 0) fail(3, "NO_CAPTIONS");
const start = html.indexOf("[", at);
let depth = 0, inStr = false, esc = false, end = -1;
for (let i = start; i < html.length; i++) {
  const c = html[i];
  if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
  if (c === '"') inStr = true;
  else if (c === "[") depth++;
  else if (c === "]") { depth--; if (depth === 0) { end = i; break; } }
}
if (end < 0) fail(3, "NO_CAPTIONS");
const tracks = JSON.parse(html.slice(start, end + 1));
const wanted = (process.env.VT_LANGS || "en").split(",");
let pick;
for (const w of wanted) { pick = tracks.find((t) => t.languageCode === w) ?? tracks.find((t) => String(t.languageCode).startsWith(w + "-")); if (pick) break; }
pick = pick ?? tracks[0];
if (!pick || !pick.baseUrl) fail(3, "NO_CAPTIONS");
const u = new URL(pick.baseUrl);
if (!(u.hostname === "youtube.com" || u.hostname.endsWith(".youtube.com"))) fail(4, "unexpected caption host");
u.searchParams.set("fmt", "vtt");
const r = await fetch(u, { headers });
const body = await r.text();
if (!body.trim() || !body.includes("-->")) fail(4, "caption download returned no text (HTTP " + r.status + ")");
const fs = await import("node:fs");
fs.mkdirSync(process.env.VT_DIR, { recursive: true });
fs.writeFileSync(process.env.VT_DIR + "/sub." + pick.languageCode + ".vtt", body);
console.log("sub." + pick.languageCode + ".vtt");
`;

export function captionTracksCommand(dir: string, url: string, languages: readonly string[]): string {
	// node 22.21+ (e 24) lê HTTPS_PROXY com NODE_USE_ENV_PROXY=1; versão mais antiga ignora e segue como antes (só youtube.com é buscado).
	return `NODE_USE_ENV_PROXY=1 HTTPS_PROXY="${EGRESS_PROXY_URL}" HTTP_PROXY="${EGRESS_PROXY_URL}" VT_URL=${shq(url)} VT_DIR=${shq(dir)} VT_LANGS=${shq(languages.join(","))} node --input-type=module -e ${shq(CAPTION_TRACKS_SCRIPT)}`;
}
