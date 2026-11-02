// Pose de repouso dos avatares da lista: corpo meio de lado, olhando para cima e para a direita, o que dá a
// sensação de 3D da referência do dono. É o mesmo campo que o motor do web usa (`Frame.orientation`, em graus,
// lido por `projectFrame`): o web não tem uma pose fixa de lista (parado ele é reto; yaw/pitch/roll vêm do olhar,
// dos clipes de repouso e da cutucada, que chegam a yaw 40, pitch -34 e roll 25), então os valores abaixo foram
// ajustados contra a imagem da referência e ficam dentro do que os clipes do motor alcançam.
import type { Frame } from "@workspace/shared/avatar/model/character";
import { stillFrame } from "@workspace/shared/avatar/render/still";

export type Pose = { yaw: number; pitch: number; roll: number };

/** Positivo em yaw = para a direita; negativo em pitch = para cima; positivo em roll = inclina os olhos "\\". */
export const LIST_POSE: Pose = { yaw: 26, pitch: -18, roll: 15 };

const cache = new Map<string, Frame>();

/** Quadro parado do avatar na pose dada. Memoizado por forma, expressão e pose (o quadro não é alterado depois). */
export function poseFrame(shape: string, expression: string, pose: Pose): Frame {
	const key = `${shape}|${expression}|${pose.yaw}|${pose.pitch}|${pose.roll}`;
	const hit = cache.get(key);
	if (hit) return hit;
	const frame = stillFrame(shape, expression);
	frame.orientation = { yaw: pose.yaw, pitch: pose.pitch, roll: pose.roll };
	cache.set(key, frame);
	return frame;
}
