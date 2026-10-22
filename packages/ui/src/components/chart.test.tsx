import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { chartSpecToCsv, parseChartSpec, type ChartSpec } from "@workspace/shared"
import { Chart, describeReference, horizontalBarLeftMargin, makeValueFormatter, makeXLabels, parseChartDate, shouldUseHorizontalBars } from "./chart"

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
    expect(html).toContain("R$ 750")
    expect(html).not.toContain("R$ 750,00")
    expect(html).toContain("75%")
    expect(html).toContain("25%")
    expect(html).not.toContain("Zero")
  })

  it("pizza com algum valor fracionário mantém os centavos em toda a legenda", () => {
    const html = plain(
      renderToStaticMarkup(
        <Chart spec={spec({ type: "pie", x: "canal", series: [{ key: "v" }], unit: "BRL", data: [{ canal: "Loja", v: 750 }, { canal: "Site", v: 250.5 }] })} />
      )
    )
    expect(html).toContain("R$ 750,00")
    expect(html).toContain("R$ 250,50")
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

  it("moeda com `whole` mostra reais cheios; sem ele (ou com centavos) segue com 2 casas", () => {
    expect(plain(makeValueFormatter({ unit: "BRL" }, { whole: true })(28_400))).toBe("R$ 28.400")
    expect(plain(makeValueFormatter({ unit: "BRL" })(28_400))).toBe("R$ 28.400,00")
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

describe("Chart: paleta", () => {
  it("sem paleta não injeta estilo nem escopo (visual padrão)", () => {
    const html = renderToStaticMarkup(<Chart spec={spec({ ...monthly, type: "line" })} />)
    expect(html).not.toContain("data-chart-palette")
    expect(html).not.toContain("<style")
  })

  it("paleta pronta escopa o CSS no gráfico, com valores claro e escuro", () => {
    const html = renderToStaticMarkup(<Chart spec={spec({ ...monthly, type: "bar", palette: "ocean" })} />)
    expect(html).toContain('data-chart-palette="ocean"')
    expect(html).toContain('[data-chart-palette="ocean"]{--chart-1:oklch(0.546 0.245 262.881);')
    expect(html).toContain('.dark [data-chart-palette="ocean"]')
  })

  it("paleta personalizada usa as cores informadas", () => {
    const html = renderToStaticMarkup(<Chart spec={spec({ ...monthly, type: "line", colors: ["#1d4ed8", "#b45309"] })} />)
    expect(html).toMatch(/data-chart-palette="custom-[a-z0-9]+"/)
    expect(html).toContain("--chart-1:#1d4ed8;")
    expect(html).toContain("--chart-2:#b45309;")
  })
})

describe("Chart: correções de layout", () => {
  const pie = (extra: Record<string, unknown>) =>
    spec({ type: "pie", x: "canal", series: [{ key: "v" }], data: [{ canal: "Loja", v: 62 }, { canal: "Site", v: 38 }], ...extra })

  it("pizza: o total do centro fica fora do <svg>", () => {
    const html = plain(renderToStaticMarkup(<Chart spec={pie({ unit: "BRL" })} />))
    const afterSvg = html.slice(html.lastIndexOf("</svg>"))
    expect(afterSvg).toContain("R$ 100")
    expect(html.slice(0, html.lastIndexOf("</svg>"))).not.toContain("R$ 100")
  })

  it("pizza com unidade % mostra o valor uma vez só", () => {
    const html = plain(renderToStaticMarkup(<Chart spec={pie({ unit: "%" })} />))
    expect(html.match(/38%/g)).toHaveLength(1)
  })

  it("barras: datas e nomes curtos ficam na vertical; nomes longos e numerosos vão para horizontal", () => {
    const months = Array.from({ length: 12 }, (_, i) => `jan/${25 + i}`)
    expect(shouldUseHorizontalBars(months, 400)).toBe(false)
    const produtos = ["Camiseta básica branca", "Calça jeans slim", "Tênis casual urbano", "Jaqueta corta-vento", "Boné aba curva", "Meia esportiva (par)"]
    expect(shouldUseHorizontalBars(produtos, 520)).toBe(true)
    expect(shouldUseHorizontalBars(["Camiseta básica branca", "Calça jeans"], 520)).toBe(false)
  })

  it("barras horizontais: margem esquerda acompanha o maior rótulo, com teto", () => {
    expect(horizontalBarLeftMargin(["Boné"])).toBe(56)
    expect(horizontalBarLeftMargin(["Camiseta básica branca"])).toBeGreaterThan(120)
    expect(horizontalBarLeftMargin(["x".repeat(80)])).toBe(160)
  })
})

describe("Chart: novos tipos", () => {
  const months = [
    { mes: "2025-01-01", receita: 1000, meta: 900 },
    { mes: "2025-02-01", receita: 1400, meta: 950 },
    { mes: "2025-03-01", receita: 1700, meta: 1000 },
    { mes: "2025-04-01", receita: 2100, meta: 1050 },
  ]

  it("radar: uma área por série e nota da escala relativa", () => {
    const html = plain(
      renderToStaticMarkup(
        <Chart
          spec={spec({
            type: "radar",
            x: "eixo",
            series: [{ key: "a", label: "Loja A" }, { key: "b", label: "Loja B" }],
            data: [{ eixo: "Preço", a: 80, b: 60 }, { eixo: "Prazo", a: 70, b: 90 }, { eixo: "Qualidade", a: 90, b: 75 }],
          })}
        />
      )
    )
    expect(html).toContain('data-chart-type="radar"')
    expect(html).toContain("Escala relativa ao maior valor (90)")
    expect(html).toContain("Loja A")
    expect(html).toContain("Loja B")
  })

  it("funil: renderiza a moldura (o desenho depende da medida, só no navegador)", () => {
    const html = plain(
      renderToStaticMarkup(<Chart spec={spec({ type: "funnel", x: "etapa", series: [{ key: "v" }], data: [{ etapa: "Leads", v: 12400 }, { etapa: "Venda", v: 620 }] })} />)
    )
    expect(html).toContain('data-chart-type="funnel"')
    expect(html).toContain("aspect-ratio")
  })

  it("medidor: renderiza com rótulo da série e sem legenda", () => {
    const html = renderToStaticMarkup(<Chart spec={spec({ type: "gauge", x: "m", series: [{ key: "v", label: "Meta atingida" }], data: [{ m: "mês", v: 72 }], unit: "%" })} />)
    expect(html).toContain('data-chart-type="gauge"')
    expect(html).not.toContain('data-slot="chart-legend"')
  })

  it("composto: barras e linhas na mesma moldura, com legenda", () => {
    const html = renderToStaticMarkup(
      <Chart spec={spec({ type: "composed", x: "mes", series: [{ key: "receita", label: "Receita", kind: "bar" }, { key: "meta", label: "Meta", kind: "line" }], data: months })} />
    )
    expect(html).toContain('data-chart-type="composed"')
    expect(html).toContain("Receita")
    expect(html).toContain("Meta")
  })

  it("meta e faixa: texto da legenda com a unidade e o rótulo", () => {
    expect(plain(describeReference(spec({ type: "line", x: "mes", series: [{ key: "receita" }], data: months, unit: "BRL", reference: { from: 1500, label: "Meta" } }))!)).toBe("Meta (a partir de R$ 1.500,00)")
    expect(describeReference(spec({ type: "bar", x: "mes", series: [{ key: "receita" }], data: months, reference: { from: 800, to: 1000 } }))).toBe("800 – 1.000")
    expect(describeReference(spec({ type: "bar", x: "mes", series: [{ key: "receita" }], data: months }))).toBeNull()
  })

  it("meta renderiza a legenda; projeção não quebra a renderização", () => {
    const html = plain(
      renderToStaticMarkup(
        <Chart spec={spec({ type: "line", x: "mes", series: [{ key: "receita" }], data: months, reference: { from: 1500, to: 1800, label: "Faixa" }, forecast: { points: 3 } })} />
      )
    )
    expect(html).toContain('data-slot="chart-reference"')
    expect(html).toContain("Faixa (1.500 – 1.800)")
  })
})
