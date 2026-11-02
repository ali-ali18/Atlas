import { describe, expect, it } from "vitest";
import { SPIN_BASE_POSE, SPIN_PERIOD_S, SPIN_STEPS, spinPose, spinPoseAtStep, spinStep, spinYaw, stepYaw } from "./avatar-spin";

describe("giro do avatar (yaw)", () => {
	it("vai de 0° a 360° em uma volta (1,6 s) e fecha o laço", () => {
		expect(spinYaw(0)).toBe(0);
		expect(spinYaw(SPIN_PERIOD_S / 4)).toBeCloseTo(90, 5);
		expect(spinYaw(SPIN_PERIOD_S / 2)).toBeCloseTo(180, 5);
		expect(spinYaw((SPIN_PERIOD_S * 3) / 4)).toBeCloseTo(270, 5);
		expect(spinYaw(SPIN_PERIOD_S)).toBe(0);
		expect(spinYaw(SPIN_PERIOD_S * 5 + SPIN_PERIOD_S / 2)).toBeCloseTo(180, 5);
	});
	it("nunca devolve 360 nem valor fora de [0, 360)", () => {
		for (let t = 0; t < 6; t += 0.0137) {
			const yaw = spinYaw(t);
			expect(yaw).toBeGreaterThanOrEqual(0);
			expect(yaw).toBeLessThan(360);
		}
		expect(spinYaw(SPIN_PERIOD_S - 1e-12)).toBeLessThan(360);
	});
	it("é linear: velocidade constante (sem parar de frente a cada volta)", () => {
		const step = spinYaw(0.1) - spinYaw(0);
		expect(spinYaw(0.9) - spinYaw(0.8)).toBeCloseTo(step, 5);
	});
	it("a curva do motor segue yaw = 180·(1 − cos(π·t/volta)): devagar de frente, rápido de lado", () => {
		expect(spinYaw(SPIN_PERIOD_S / 2, SPIN_PERIOD_S, "motor")).toBeCloseTo(180, 5);
		expect(spinYaw(SPIN_PERIOD_S / 4, SPIN_PERIOD_S, "motor")).toBeCloseTo(180 * (1 - Math.cos(Math.PI / 4)), 5);
		expect(spinYaw(0.1, SPIN_PERIOD_S, "motor")).toBeLessThan(spinYaw(0.1, SPIN_PERIOD_S, "linear"));
	});
	it("respeita outro período e tempo negativo", () => {
		expect(spinYaw(0.5, 1)).toBeCloseTo(180, 5);
		expect(spinYaw(-0.25, 1)).toBeCloseTo(270, 5);
	});
	it("entrada inválida fica parada em 0°", () => {
		expect(spinYaw(Number.NaN)).toBe(0);
		expect(spinYaw(1, 0)).toBe(0);
		expect(spinYaw(1, -3)).toBe(0);
		expect(spinYaw(Number.POSITIVE_INFINITY)).toBe(0);
	});
	it("passos: 48 por volta, de 0 a 47, com yaw de 7,5° por passo", () => {
		expect(SPIN_STEPS).toBe(48);
		expect(spinStep(0)).toBe(0);
		expect(spinStep(SPIN_PERIOD_S / 2)).toBe(24);
		expect(spinStep(SPIN_PERIOD_S - 1e-9)).toBe(47);
		expect(spinStep(SPIN_PERIOD_S)).toBe(0);
		expect(stepYaw(24)).toBe(180);
		expect(stepYaw(48)).toBe(0);
	});
});

describe("pose do giro (base inclinada + giro)", () => {
	it("a base é de lado e olhando para cima (yaw > 0, pitch < 0)", () => {
		expect(SPIN_BASE_POSE.yaw).toBeGreaterThan(0);
		expect(SPIN_BASE_POSE.pitch).toBeLessThan(0);
	});
	it("o passo 0 é exatamente a base (a pose parada com movimento reduzido)", () => {
		expect(spinPoseAtStep(0)).toEqual(SPIN_BASE_POSE);
		expect(spinPose(0)).toEqual(SPIN_BASE_POSE);
	});
	it("só o yaw gira: pitch e roll ficam os da base em todos os passos", () => {
		for (let step = 0; step < SPIN_STEPS; step++) {
			const pose = spinPoseAtStep(step);
			expect(pose.pitch).toBe(SPIN_BASE_POSE.pitch);
			expect(pose.roll).toBe(SPIN_BASE_POSE.roll);
			expect(pose.yaw).toBeGreaterThanOrEqual(0);
			expect(pose.yaw).toBeLessThan(360);
		}
	});
	it("o yaw é a base mais o giro e fecha o laço na volta seguinte", () => {
		expect(spinPoseAtStep(24).yaw).toBe((SPIN_BASE_POSE.yaw + 180) % 360);
		expect(spinPose(SPIN_PERIOD_S / 2).yaw).toBe((SPIN_BASE_POSE.yaw + 180) % 360);
		expect(spinPose(SPIN_PERIOD_S)).toEqual(SPIN_BASE_POSE);
		expect(spinPoseAtStep(SPIN_STEPS)).toEqual(SPIN_BASE_POSE);
	});
	it("aceita outra base", () => {
		expect(spinPoseAtStep(24, { yaw: 300, pitch: -5, roll: 0 })).toEqual({ yaw: 120, pitch: -5, roll: 0 });
	});
});
