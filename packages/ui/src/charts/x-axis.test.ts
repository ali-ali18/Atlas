import { describe, expect, it } from "vitest";
import { buildDomainTicks, nearestMonthStart } from "./x-axis";

/** Escala linear mínima: o domínio inteiro ocupa `width` px. */
function linearScale(start: Date, end: Date, width: number) {
  const scale = (date: Date) =>
    ((date.getTime() - start.getTime()) / (end.getTime() - start.getTime())) *
    width;
  return Object.assign(scale, { domain: () => [start, end] });
}

const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const monthYear = (date: Date) =>
  `${MONTHS[date.getMonth()]}/${String(date.getFullYear() % 100).padStart(2, "0")}`;

describe("ticks do eixo X por domínio (dados + projeção)", () => {
  // 12 meses de dados mais 3 de projeção, como o gráfico de linha com forecast.
  const scale = linearScale(new Date(2025, 0, 1), new Date(2026, 2, 1), 450);

  it("usa o formatador do gráfico (mês/ano) em vez de dd/mm e mostra mais que o primeiro e o último", () => {
    const ticks = buildDomainTicks({
      formatDate: monthYear,
      marginLeft: 10,
      numTicks: 5,
      snapToMonth: true,
      xScale: scale,
    });
    expect(ticks.map((tick) => tick.label)).toEqual([
      "jan/25",
      "mai/25",
      "ago/25",
      "nov/25",
      "mar/26",
    ]);
  });

  it("encaixa os ticks do meio no dia 1 do mês mais próximo", () => {
    expect(nearestMonthStart(new Date(2025, 3, 15)).getTime()).toBe(new Date(2025, 3, 1).getTime());
    expect(nearestMonthStart(new Date(2025, 3, 17)).getTime()).toBe(new Date(2025, 4, 1).getTime());
    const ticks = buildDomainTicks({ formatDate: monthYear, marginLeft: 0, numTicks: 4, snapToMonth: true, xScale: scale });
    for (const tick of ticks) expect(tick.date.getDate()).toBe(1);
  });

  it("espaça por igual, desloca pela margem e cobre as duas pontas do domínio", () => {
    const ticks = buildDomainTicks({
      formatDate: monthYear,
      marginLeft: 10,
      numTicks: 4,
      xScale: scale,
    });
    expect(ticks).toHaveLength(4);
    expect(ticks[0]?.x).toBe(10);
    expect(ticks.at(-1)?.x).toBeCloseTo(460, 5);
  });

  it("sem formatador usa dd/mm e descarta rótulos repetidos", () => {
    const narrow = linearScale(new Date(2025, 0, 1, 0), new Date(2025, 0, 1, 20), 100);
    const ticks = buildDomainTicks({ marginLeft: 0, numTicks: 5, xScale: narrow });
    expect(ticks.map((tick) => tick.label)).toEqual(["01/01"]);
  });
});
