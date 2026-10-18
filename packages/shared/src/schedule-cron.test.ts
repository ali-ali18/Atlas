import { describe, expect, it } from "vitest";
import { isCronFive, scheduleStateToCron, cronToScheduleInput } from "./schedule-cron.js";

const base = {
	frequency: "daily",
	time: "9:00",
	minute: ":00",
	weekday: "segunda-feira",
	monthDay: "1",
	intervalValue: "30",
	intervalUnit: "minutos",
	expression: "",
};

describe("scheduleStateToCron", () => {
	it("converte diário 9:00", () => {
		expect(scheduleStateToCron(base)).toBe("0 9 * * *");
	});
	it("converte dias úteis", () => {
		expect(scheduleStateToCron({ ...base, frequency: "weekdays", time: "8:15" })).toBe(
			"15 8 * * 1-5",
		);
	});
	it("converte intervalo de 6 horas", () => {
		expect(
			scheduleStateToCron({
				...base,
				frequency: "interval",
				intervalValue: "6",
				intervalUnit: "horas",
			}),
		).toBe("0 */6 * * *");
	});
	it("reabre diário a partir do cron", () => {
		expect(cronToScheduleInput("0 9 * * *").frequency).toBe("daily");
		expect(cronToScheduleInput("0 9 * * *").time).toBe("9:00");
	});
	it("valida cron de 5 campos", () => {
		expect(isCronFive("0 9 * * *")).toBe(true);
		expect(isCronFive("todo dia")).toBe(false);
	});
});
