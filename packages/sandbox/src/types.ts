import type { SandboxSessionStatus } from "@workspace/shared";

export type SandboxSessionRecord = {
	userId: string;
	sessionId: string;
	conversationId?: string;
	containerId: string;
	containerName: string;
	status: SandboxSessionStatus;
	viewerPort: number;
	controlPort: number;
	/** Host para falar com a VM; ausente = `config.controlHost` (portas publicadas). */
	host?: string;
	createdAt: Date;
	/** Última vez que a sessão foi usada (para o TTL/GC). */
	lastUsedAt: Date;
};

/**
 * Onde o servidor agiu (centro do elemento em coordenadas da tela do sandbox)
 * e o nome curto dele. Best effort: ausente em imagens antigas ou se a medição falhar.
 */
export type ControlPointer = {
	x: number;
	y: number;
	/** Tamanho da tela em que x/y foram medidos. */
	screenW?: number;
	screenH?: number;
	/** Nome acessível do elemento (já truncado; ausente em campo sensível). */
	name?: string;
	/** Campo de senha/segredo: o rótulo nunca cita o nome nem o texto. */
	sensitive?: boolean;
};

/** V4 — o que mudou na página por causa da ação (servidor novo; campos ausentes = nada). */
export type ControlPageChanges = {
	/** Documento novo: a página é outra, o texto não é comparado e os refs antigos morreram. */
	reloaded?: boolean;
	/** Título novo, quando mudou. */
	title?: string;
	/** Texto que apareceu (blocos separados por " | ", teto de 1000 chars). */
	added?: string;
	addedBlocks?: number;
	/** Total de chars do texto novo quando passou do teto. */
	addedTotalChars?: number;
	removedBlocks?: number;
	/** Ex.: `e20 "Week 1" expanded false→true`. */
	states?: string[];
	dialogsOpened?: string[];
	dialogsClosed?: string[];
};

/** Efeito observado depois de uma ação (servidor novo; ausente em imagens antigas). */
export type ControlActionEffect = {
	pointer?: ControlPointer;
	url?: string;
	title?: string;
	/** A URL mudou por causa da ação. */
	navigated?: boolean;
	/** O DOM ficou sem mutação por 300 ms dentro do teto de 4 s. */
	settled?: boolean;
	/** Quanto a espera automática pós-ação durou (ms). */
	waitMs?: number;
	/** O que mudou na página (texto novo, estados, diálogos). */
	changes?: ControlPageChanges;
	/** Erros de validação NOVOS (campo inválido ou alerta dentro de form/diálogo). */
	errors?: string[];
	/** Elementos novos ou que reapareceram, uma linha com ref cada. */
	newElements?: string[];
	newTotal?: number;
	/** Clique: degrau da escada que funcionou (click, scroll, banner, overlay, keyboard, js, coords). */
	rung?: "click" | "scroll" | "banner" | "overlay" | "keyboard" | "js" | "coords";
	/** Clique: degraus tentados, em ordem. */
	tried?: string[];
	/** Clique: um banner de consentimento foi recusado/fechado (nunca aceito). */
	dismissed?: "consent";
	/** Clique: o alvo foi trocado pelo ancestral interativo, ex. `<a "Title">`. */
	retargeted?: string;
};

export type ControlActionResult = ControlActionEffect & { ok?: boolean };

export type ControlNavigateResult = {
	url: string;
	title: string;
} & Pick<ControlActionEffect, "navigated" | "settled"> & {
	/** O conteúdo apareceu e estabilizou dentro do teto (false: SPA ainda montando). */
	ready?: boolean;
	/** Tempo do `goto` e da espera de prontidão (ms). */
	gotoMs?: number;
	readyMs?: number;
	hint?: string;
};

export type ControlScreenResult = {
	width: number;
	height: number;
};

export type ControlBrowserTextResult = {
	url: string;
	title: string;
	text: string;
	/** Paginação (servidor novo); imagens antigas devolvem só url/title/text. */
	mode?: "page" | "viewport";
	offset?: number;
	limit?: number;
	totalLength?: number;
	truncated?: boolean;
	nextOffset?: number | null;
	scrollY?: number;
	scrollHeight?: number;
	viewportHeight?: number;
};

export type ControlBrowserTextOptions = {
	offset?: number;
	limit?: number;
	mode?: "page" | "viewport";
};

export type ControlScrollResult = {
	ok?: boolean;
	scrollY?: number;
	scrollHeight?: number;
	viewportHeight?: number;
};

export type ControlBrowserLinksResult = {
	url: string;
	links: { text: string; href: string }[];
};

export type ControlBrowserClickResult = ControlActionEffect & {
	ok: boolean;
	target: string;
	/** Clique por texto: quantos elementos casaram e se o escolhido era ambíguo. */
	matches?: number;
	ambiguous?: boolean;
};

export type ControlSnapshotOptions = {
	scope?: string;
	offset?: number;
	limit?: number;
	area?: "viewport" | "page";
};

export type ControlSnapshotResult = {
	url: string;
	title: string;
	total: number;
	offset: number;
	limit: number;
	nextOffset: number | null;
	scrollY?: number;
	scrollHeight?: number;
	viewportHeight?: number;
	/** Uma linha compacta por elemento, já com o ref: `[e3] textbox "Cliente" ...`. */
	lines: string[];
};

export type ControlReadOptions = {
	/** outline (padrão): títulos, links com href, interativos com ref; text: só a leitura. */
	view?: "outline" | "text";
	/** "all" abre todos os acordeões antes de ler; lista de refs abre só esses. */
	expand?: "all" | string[];
	offset?: number;
	limit?: number;
};

export type ControlReadResult = {
	url: string;
	title: string;
	view: "outline" | "text";
	/** Trecho da leitura (já fatiado por offset/limit) e onde continuar. */
	text: string;
	offset: number;
	limit: number;
	totalLength: number;
	truncated: boolean;
	nextOffset: number | null;
	frames: number;
	/** Controles de expandir ainda fechados na página lida. */
	collapsed: number;
	/** Itens parecidos (semanas, módulos): dica para usar track_items. */
	similar?: { count: number };
	expanded?: { opened: number; failed: number; skipped: number; stoppedBy?: "limit" | "time" | "navigation" };
	/** A página passou do teto de leitura e foi cortada. */
	capped?: boolean;
	/** Continuação servida da leitura anterior (a página não foi relida). */
	cached?: boolean;
};

export type ControlFindOptions = {
	query: string;
	regex?: boolean;
	max?: number;
};

export type ControlFindMatch = {
	text: string;
	ref?: string;
	role?: string;
	/** Interativo mais próximo quando o trecho achado não é clicável. */
	near?: string;
	section?: string;
	sectionRef?: string;
	frame?: string;
	frameName?: string;
	crossOrigin?: string;
};

export type ControlFindResult = {
	url: string;
	title: string;
	query: string;
	total: number;
	matches: ControlFindMatch[];
	frames: number;
	collapsed: number;
};

export type ControlActAction =
	| "click"
	| "type"
	| "select"
	| "check"
	| "uncheck"
	| "hover"
	| "press"
	| "clear";

export type ControlActParams = {
	ref: string;
	action: ControlActAction;
	value?: string;
	submit?: boolean;
	sequential?: boolean;
};

export type ControlActResult = ControlActionEffect & {
	ok: boolean;
	ref: string;
	action: ControlActAction;
	field?: { value?: string; checked?: boolean; secret?: boolean };
	/** Erros de validação visíveis depois da ação (aria-invalid, role=alert). */
	errors?: string[];
	newElements: string[];
	newTotal: number;
};

export type ControlWaitParams = {
	for: "text" | "ref" | "url" | "network" | "stable";
	value?: string;
	timeoutMs?: number;
	gone?: boolean;
};

export type ControlWaitResult = {
	ok: boolean;
	met: boolean;
	for: string;
	waitedMs: number;
	url: string;
	title: string;
	reason?: string;
};

// --- Shell / arquivos dentro da sandbox (docker exec no container do bot) ---

export type SandboxShellResult = {
	background: boolean;
	/** Só no modo background. */
	jobId?: string;
	/** null em background (use sandbox_shell_wait). */
	exitCode: number | null;
	stdout: string;
	stderr: string;
	durationMs: number;
	timedOut: boolean;
	truncated: boolean;
};

export type SandboxShellWaitResult = {
	jobId: string;
	status: "running" | "done";
	exitCode: number | null;
	/** Saída nova desde a última leitura. */
	output: string;
	nextOffset: number;
	truncated: boolean;
};

export type SandboxReadResult = {
	path: string;
	kind: "text" | "pdf" | "image" | "binary";
	size: number;
	content: string;
	totalLines: number;
	/** Linha a passar em `offset` para continuar; null se acabou. */
	nextOffset: number | null;
	truncated: boolean;
	note?: string;
};

export type SandboxListEntry = { name: string; type: "file" | "dir" | "link"; size: number; modified: string };
export type SandboxListResult = { path: string; entries: SandboxListEntry[]; total: number; truncated: boolean };

export type SandboxWriteFileResult = { path: string; bytes: number };

export type SandboxDownloadResult = {
	path: string;
	httpStatus: number;
	contentType: string;
	bytes: number;
	usedBrowserSession: boolean;
	note?: string;
};
