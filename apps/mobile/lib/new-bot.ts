// Criar bot pelo "+" da home: a escolha inicial (sorteada ao abrir), a validação do que a pessoa digita e escolhe e o
// corpo do `POST /v1/bots`. Funções puras, testadas em new-bot.test.ts. Forma e cor só saem dos ids do motor
// (`SHAPE_IDS` e `AVATAR_COLORS` de `@workspace/shared`): o servidor ignora forma desconhecida em silêncio, então
// quem chama não pode mandar outra coisa.
import { DRAWABLE_SHAPES } from "@workspace/shared/avatar/geometry/shapes";
import { AVATAR_PALETTE, AVATAR_SHAPES, validateBotName } from "./bot-edit";

/** Formas da grade: todas as do motor, na ordem do seletor do editor de avatar. */
export const NEW_BOT_SHAPES: readonly string[] = AVATAR_SHAPES;
/** Cores da grade: a paleta do app (o cinza é a opção neutra). */
export const NEW_BOT_COLORS = AVATAR_PALETTE;

/** Gerador determinístico a partir de uma semente (mulberry32): o sorteio inicial é testável. */
export function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Cores sorteáveis ao abrir: as da paleta menos o branco (que só entra por escolha, como o preto no sorteio por id do motor). */
const DRAW_COLORS = NEW_BOT_COLORS.filter((color) => color.id !== "white");

/** Forma e cor iniciais: uma das formas "limpas" do motor (`DRAWABLE_SHAPES`, com dois olhos) e uma cor da paleta. */
export function randomAvatar(random: () => number): { shape: string; color: string } {
	const shape = DRAWABLE_SHAPES[Math.floor(random() * DRAWABLE_SHAPES.length)] ?? "blob";
	const color = DRAW_COLORS[Math.floor(random() * DRAW_COLORS.length)]?.value ?? NEW_BOT_COLORS[0]!.value;
	return { shape, color };
}

export type NewBotInput = { name: string; shape: string; color: string };
export type NewBotBody = { name: string; shape: string; color: string };
export type NewBotCheck = { ok: true; body: NewBotBody } | { ok: false; error: string };

const colorValue = (color: string): string | null => NEW_BOT_COLORS.find((item) => item.value.toLowerCase() === color.trim().toLowerCase())?.value ?? null;

/** O corpo do POST: só `name`, `shape` e `color`. Idioma e modelo ficam de fora (vale o padrão da conta). */
export function buildNewBotBody(input: NewBotInput): NewBotCheck {
	const name = validateBotName(input.name);
	if (!name.ok) return { ok: false, error: name.error };
	if (!NEW_BOT_SHAPES.includes(input.shape)) return { ok: false, error: "Escolha uma forma para o bot." };
	const color = colorValue(input.color);
	if (!color) return { ok: false, error: "Escolha uma cor para o bot." };
	return { ok: true, body: { name: name.value, shape: input.shape, color } };
}

/** Rótulo de leitor de tela da forma: posição na grade, nunca o id interno. */
export const shapeLabel = (index: number, total: number): string => `Forma ${index + 1} de ${total}`;

/** "Criar" só habilita com um nome válido (e não enquanto cria). */
export const canCreateBot = (rawName: string, busy: boolean): boolean => !busy && validateBotName(rawName).ok;
