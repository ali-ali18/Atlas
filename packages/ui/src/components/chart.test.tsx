import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { chartSpecToCsv, parseChartSpec, type ChartSpec } from "@workspace/shared"
import { Chart, makeValueFormatter, makeXLabels, parseChartDate } from "./chart"

const spec = (raw: Record<string, unknown>): ChartSpec => {
  const parsed = parseChartSpec(raw)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.spec
}
const plain = (text: string) => text.replace(/\u00a0/g, " ")

const monthly = {
  title: "Receita",
  x: "mes",
  series: [{ key: "r", label: "Receita" }, { key: "d", label: "Despesas" }],
  data: [{ mes: "2025-01-01", r: 1200.5, d: 900 }, { mes: "2025-02-01", r: 1500, d: null }, { mes: "2025-03-01", r: 1800.25, d: 1000 }],
  unit: "BRL",
}

describe("Chart: cada tipo renderiza com dados", () => {
  for (const type of ["line", "bar", "area"] as const) {
    it(`${type}: moldura, título, botão de CSV e legenda das séries`, () => {
      const html = renderToStaticMarkup(<Chart spec={spec({ ...monthly, type })} />)
      expect(html).toContain('data-slot="chart"')
      expect(html).toContain(`data-chart-type="${type}"`)
      expect(html).toContain("Receita")
      expect(html).toContain("Copiar dados (CSV)")
      expect(html).toContain("Despesas")
      expect(html).toContain('data-slot="chart-legend"')
    })
  }

  it("pizza: fatias com valor em R$ e percentual pt-BR na legenda", () => {
    const html = plain(
      renderToStaticMarkup(
        <Chart spec={spec({ type: "pie", x: "canal", series: [{ key: "v" }], unit: "BRL", data: [{ canal: "Loja", v: 750 }, { canal: "Site", v: 250 }, { canal: "Zero", v: 0 }] })} />
      )
    )
    expect(html).toContain("R$ 750,00")
    expect(html).toContain("75%")
    expect(html).toContain("25%")
    expect(html).not.toContain("Zero")
  })

  it("série única não mostra legenda; sem título o cabeçalho fica só com o botão", () => {
    const html = renderToStaticMarkup(<Chart spec={spec({ type: "bar", x: "a", series: [{ key: "v" }], data: [{ a: "x", v: 1 }] })} />)
    expect(html).not.toContain('data-slot="chart-legend"')
    expect(html).toContain('data-slot="chart-copy-csv"')
  })
})

describe("formatação pt-BR", () => {
  it("números, moeda, percentual, unidade e compacto", () => {
    expect(plain(makeValueFormatter({})(1234.567))).toBe("1.234,57")
    expect(plain(makeValueFormatter({ unit: "BRL" })(1234.5))).toBe("R$ 1.234,50")
    expect(plain(makeValueFormatter({ unit: "USD" })(10))).toBe("US$ 10,00")
    expect(makeValueFormatter({ unit: "%" })(12.5)).toBe("12,5%")
    expect(makeValueFormatter({ format: "percent" })(3)).toBe("3%")
    expect(plain(makeValueFormatter({ unit: "kg" })(2.5))).toBe("2,5 kg")
    expect(plain(makeValueFormatter({ format: "compact" })(1_500_000))).toMatch(/1,5\s?mi/)
  })

  it("eixo usa notação compacta só a partir de 10 mil", () => {
    expect(plain(makeValueFormatter({ unit: "BRL" }, { axis: true, max: 88_650 })(60_000))).toMatch(/R\$ 60 mil/)
    expect(plain(makeValueFormatter({}, { axis: true, max: 1500 })(1000))).toBe("1.000")
  })

  it("rótulos do eixo X: mensal jan/25, diário dd/mm, categorias intactas; data sem deslocamento de fuso", () => {
    const month = makeXLabels(spec({ ...monthly, type: "line" }))
    expect(month.axis("2025-02-01")).toBe("fev/25")
    expect(month.title("2025-02-01")).toBe("fevereiro de 2025")
    const daily = makeXLabels(spec({ type: "line", x: "d", series: [{ key: "v" }], data: [{ d: "2025-06-03", v: 1 }, { d: "2025-06-20", v: 2 }] }))
    expect(daily.axis("2025-06-03")).toBe("03/06")
    expect(daily.title("2025-06-03")).toBe("03/06/2025")
    expect(makeXLabels(spec({ type: "bar", x: "a", series: [{ key: "v" }], data: [{ a: "Centro", v: 1 }] })).axis("Centro")).toBe("Centro")
    expect(parseChartDate("2025-01-01").getDate()).toBe(1)
  })
})

describe("CSV", () => {
  it("copia os dados em pt-BR com os rótulos das séries", () => {
    expect(chartSpecToCsv(spec({ ...monthly, type: "line" }))).toBe("mes;Receita;Despesas\n2025-01-01;1200,5;900\n2025-02-01;1500;\n2025-03-01;1800,25;1000")
  })
})
