import { stillFrame } from "@workspace/shared/avatar/render/still";
import { projectFrame } from "@workspace/shared/avatar/render/project";
import { describe, expect, it } from "vitest";
import { LIST_POSE, poseFrame } from "./avatar-pose";

describe("poseFrame", () => {
	it("o quadro de repouso do motor é reto", () => {
		expect(stillFrame("blob", "neutral").orientation).toEqual({ yaw: 0, pitch: 0, roll: 0 });
	});
	it("a pose da lista olha para cima e para a direita, dentro do que os clipes do motor alcançam", () => {
		expect(LIST_POSE.yaw).toBeGreaterThan(0);
		expect(LIST_POSE.pitch).toBeLessThan(0);
		expect(Math.abs(LIST_POSE.yaw)).toBeLessThanOrEqual(40);
		expect(Math.abs(LIST_POSE.pitch)).toBeLessThanOrEqual(34);
		expect(Math.abs(LIST_POSE.roll)).toBeLessThanOrEqual(25);
	});
	it("aplica a pose, é memoizado e não altera o quadro reto", () => {
		const posed = poseFrame("blob", "neutral", LIST_POSE);
		expect(posed.orientation).toEqual(LIST_POSE);
		expect(poseFrame("blob", "neutral", LIST_POSE)).toBe(posed);
		expect(stillFrame("blob", "neutral").orientation.yaw).toBe(0);
	});
	it("o 3D muda mesmo o desenho dos olhos", () => {
		const flat = projectFrame(stillFrame("blob", "neutral")).eyes;
		expect(projectFrame(poseFrame("blob", "neutral", LIST_POSE)).eyes).not.toBe(flat);
	});
});
