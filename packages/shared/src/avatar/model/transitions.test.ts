// Transições entre os estados que o app usa: nenhuma pode ser corte seco, e nenhum olho pode ficar
// recortando o ponto do indicador (a "mordida" no meio de Pensando e do radar de Pesquisando).
import { describe, expect, it } from "vitest";

import { createAvatarEngine } from "../engine.js";
import { projectEyes } from "../render/project.js";
import { renderFrame } from "../render/svg.js";
import type { Frame } from "./character.js";
import type { AvatarState } from "./behavior.js";
import { FACE_GONE, faceScale } from "./indicator.js";

export const APP_STATES = [
	"idle",
	"working",
	"thinking",
	"streaming",
	"searching",
	"reading",
	"coding",
	"running",
	"controlling",
	"waiting",
	"progress",
	"failed",
	"finished",
] as const satisfies readonly AvatarState[];

const SHAPES = ["cloud", "heart", "hex", "blob"] as const;
const FRAME_MS = 16;

function make(shape: string, state: AvatarState) {
	const e = createAvatarEngine({ shape, seed: "adolfinho", size: 240 });
	e.advance(1500);
	e.setState(state);
	if (state === "progress") e.setProgress(0.4);
	return e;
}

/** Quadro a quadro: o quadro de antes da troca entra na lista (a troca pode acontecer no 1º quadro). */
function transition(shape: string, from: AvatarState, to: AvatarState, ms = 1000): Frame[] {
	const e = make(shape, from);
	for (let t = 0; t < 2500; t += FRAME_MS) e.advance(FRAME_MS);
	const frames: Frame[] = [structuredClone(e.snapshot())];
	e.setState(to);
	if (to === "progress") e.setProgress(0.4);
	for (let t = 0; t < ms; t += FRAME_MS) frames.push(structuredClone(e.advance(FRAME_MS)));
	return frames;
}

const SIGNALS: Array<[string, (f: Frame) => number, number]> = [
	["yaw", (f) => f.orientation.yaw, 8],
	["pitch", (f) => f.orientation.pitch, 8],
	["roll", (f) => f.orientation.roll, 8],
	["zoom", (f) => f.scale * 100, 4],
	["indicador", (f) => (f.indicator?.amount ?? 0) * 100, 30],
	["corpo", (f) => f.fit * 100, 10],
];

/** Maior salto de um quadro para o outro em relação à variação total na janela (1 = corte seco). */
export function stepRatio(frames: Frame[], pick: (f: Frame) => number): { ratio: number; range: number } {
	const x = frames.map(pick);
	const range = Math.max(...x) - Math.min(...x);
	let step = 0;
	for (let i = 1; i < x.length; i++) step = Math.max(step, Math.abs((x[i] as number) - (x[i - 1] as number)));
	return { ratio: range === 0 ? 0 : step / range, range };
}

describe("transições entre os estados do app", () => {
	for (const shape of SHAPES) {
		it(`nenhuma das ${APP_STATES.length * (APP_STATES.length - 1)} trocas é corte seco (forma ${shape})`, () => {
			const cuts: string[] = [];
			for (const from of APP_STATES) {
				for (const to of APP_STATES) {
					if (from === to) continue;
					const frames = transition(shape, from, to);
					for (const [name, pick, min] of SIGNALS) {
						const { ratio, range } = stepRatio(frames, pick);
						if (range >= min && ratio > 0.45) cuts.push(`${from} → ${to}: ${name} ${(ratio * 100).toFixed(0)}% de ${range.toFixed(1)} num quadro`);
					}
					// trocar de indicador com os dois visíveis = corte seco entre desenhos
					for (let i = 1; i < frames.length; i++) {
						const a = frames[i - 1]?.indicator;
						const b = frames[i]?.indicator;
						if (a && b && a.kind !== b.kind && a.amount > 0.1 && b.amount > 0.1) cuts.push(`${from} → ${to}: indicador ${a.kind} → ${b.kind} com corpo já virado`);
					}
				}
			}
			expect(cuts).toEqual([]);
		});
	}

	it("nenhum olho fica sobre o indicador: encolhem com o morph e somem antes do ponto", () => {
		const bites: string[] = [];
		for (const shape of SHAPES) {
			for (const from of APP_STATES) {
				for (const to of APP_STATES) {
					if (from === to) continue;
					for (const f of transition(shape, from, to, 900)) {
						const ind = f.indicator;
						if (!ind) continue;
						if (ind.amount >= FACE_GONE && projectEyes(f) !== "") bites.push(`${shape} ${from} → ${to}: olho desenhado com indicador em ${ind.amount.toFixed(2)}`);
						// em andamento: o olho não pode ser maior que o do corpo normal escalado pelo morph
						const k = faceScale(ind.amount);
						for (const eye of f.eyes) if (eye.width > 0.26 * 250 * k + 1e-6 && eye.width > 1) bites.push(`${shape} ${from} → ${to}: olho largo demais (${eye.width.toFixed(1)}) com amount ${ind.amount.toFixed(2)}`);
					}
				}
			}
		}
		expect(bites).toEqual([]);
	});

	it("o SVG do indicador não leva recorte de olho no meio do ponto (pensando, radar, órbita, anel)", () => {
		for (const state of ["thinking", "searching", "waiting", "progress"] as const) {
			const e = make("cloud", state);
			for (let t = 0; t < 1500; t += FRAME_MS) {
				const f = e.advance(FRAME_MS);
				if ((f.indicator?.amount ?? 0) < FACE_GONE) continue;
				const eyes = projectEyes(f);
				expect(eyes, `${state} @${t}`).toBe("");
				const svg = renderFrame(f, { color: "#FF6700", size: 240, id: "a" });
				// o recorte dos olhos (máscara) fica vazio: nada fura o corpo-ponto
				expect(svg).toContain('<path d="" fill="#000"/>');
			}
		}
	});

	it("faceScale: 1 com o corpo normal, 0 a partir de FACE_GONE, monótono", () => {
		expect(faceScale(0)).toBe(1);
		expect(faceScale(FACE_GONE)).toBe(0);
		expect(faceScale(1)).toBe(0);
		let prev = 1;
		for (let a = 0; a <= 1; a += 0.02) {
			const v = faceScale(a);
			expect(v).toBeLessThanOrEqual(prev + 1e-12);
			prev = v;
		}
	});
});
