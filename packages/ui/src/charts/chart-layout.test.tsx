import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { AreaChartLoading } from "./area-chart-loading"
import { BarChartLoading } from "./bar-chart-loading"
import { LineChartLoading } from "./line-chart-loading"
import { collectBarValueExtents, resolveBarValueDomain } from "./y-domain-utils"

describe("esqueletos de carregamento", () => {
  for (const [name, Loading] of [
    ["barras", BarChartLoading],
    ["linha", LineChartLoading],
    ["área", AreaChartLoading],
  ] as const) {
    it(`${name}: sem aspectRatio ocupa a altura do contêiner (não estoura um wrapper fixo)`, () => {
      const html = renderToStaticMarkup(<Loading />)
      expect(html).toContain("h-full")
      expect(html).toContain("min-h-[160px]")
      expect(html).not.toContain("aspect-ratio")
    })

    it(`${name}: com aspectRatio explícito mantém a proporção pedida`, () => {
      const html = renderToStaticMarkup(<Loading aspectRatio="3 / 1" />)
      expect(html).toContain("aspect-ratio:3 / 1")
      expect(html).not.toContain("min-h-[160px]")
    })
  }
})

describe("domínio do eixo de valor das barras", () => {
  const data = [
    { a: 40, b: 30, c: 20 },
    { a: 10, b: 5, c: 5 },
  ]

  it("empilhadas: o topo do domínio comporta a soma (90), não o maior valor (40)", () => {
    const extents = collectBarValueExtents(data, ["a", "b", "c"], true)
    expect(extents.maxValue).toBe(90)
    expect(resolveBarValueDomain(extents)[1]).toBeCloseTo(99)
  })

  it("agrupadas: usa o maior valor individual", () => {
    expect(collectBarValueExtents(data, ["a", "b", "c"], false).maxValue).toBe(40)
  })
})
