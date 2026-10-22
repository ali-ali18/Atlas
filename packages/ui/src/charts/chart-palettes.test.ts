import { describe, expect, it } from "vitest"
import {
  buildCustomPalette,
  chartPaletteCss,
  contrastRatio,
  ensureContrast,
  MIN_GRAPHIC_CONTRAST,
  PRESET_PALETTE_IDS,
  PRESET_PALETTES,
  resolveChartPalette,
} from "./chart-palettes"

describe("paletas prontas", () => {
  it("são as seis do Bklit, cada uma com 6 cores em claro e escuro", () => {
    expect(PRESET_PALETTE_IDS).toEqual(["primary", "monochrome", "ocean", "sunset", "grove", "vivid"])
    for (const id of PRESET_PALETTE_IDS) {
      expect(PRESET_PALETTES[id].light.series).toHaveLength(6)
      expect(PRESET_PALETTES[id].dark.series).toHaveLength(6)
    }
  })

  it("usa as cores exatas do upstream (oceano e primária)", () => {
    expect(PRESET_PALETTES.ocean.light.series[0]).toBe("oklch(0.546 0.245 262.881)")
    expect(PRESET_PALETTES.ocean.dark.series[0]).toBe("oklch(0.623 0.214 259.815)")
    expect(PRESET_PALETTES.primary.light.series[4]).toBe("oklch(0 0 0)")
    expect(PRESET_PALETTES.primary.dark.series[4]).toBe("oklch(1 0 0)")
  })
})

describe("resolveChartPalette", () => {
  it("sem paleta devolve undefined (visual padrão)", () => {
    expect(resolveChartPalette(undefined)).toBeUndefined()
  })

  it("resolve uma paleta pronta com escopo igual ao id", () => {
    expect(resolveChartPalette("sunset")?.scope).toBe("sunset")
  })

  it("custom sem cores válidas cai no padrão", () => {
    expect(resolveChartPalette("custom")).toBeUndefined()
    expect(resolveChartPalette("custom", ["azul"])).toBeUndefined()
  })

  it("custom com cores gera escopo estável pelas cores", () => {
    const a = resolveChartPalette("custom", ["#2563eb", "#f59e0b"])
    const b = resolveChartPalette("custom", ["#2563eb", "#f59e0b"])
    const c = resolveChartPalette("custom", ["#2563eb", "#f59e0c"])
    expect(a?.scope).toBe(b?.scope)
    expect(a?.scope).not.toBe(c?.scope)
  })
})

describe("paleta personalizada", () => {
  it("rejeita lista vazia, mais de 6 e hex inválido", () => {
    expect(buildCustomPalette([]).ok).toBe(false)
    expect(buildCustomPalette(Array(7).fill("#111111")).ok).toBe(false)
    const invalid = buildCustomPalette(["#2563eb", "rgb(0,0,0)"])
    expect(!invalid.ok && invalid.error).toContain("cor 2")
  })

  it("preenche as 6 posições repetindo em ciclo", () => {
    const built = buildCustomPalette(["#2563eb", "#dc2626"])
    if (!built.ok) throw new Error(built.error)
    expect(built.palette.light.series[2]).toBe(built.palette.light.series[0])
    expect(built.palette.light.series[5]).toBe(built.palette.light.series[1])
  })

  it("garante contraste mínimo nos dois temas (amarelo claro e azul escuro)", () => {
    const built = buildCustomPalette(["#fde047", "#0b1d4a"])
    if (!built.ok) throw new Error(built.error)
    for (const color of built.palette.light.series) expect(contrastRatio(color, "#ffffff")).toBeGreaterThanOrEqual(MIN_GRAPHIC_CONTRAST)
    for (const color of built.palette.dark.series) expect(contrastRatio(color, "#18181b")).toBeGreaterThanOrEqual(MIN_GRAPHIC_CONTRAST)
  })

  it("não mexe em cor que já passa", () => {
    expect(ensureContrast("#1d4ed8", "#ffffff")).toBe("#1d4ed8")
  })
})

describe("chartPaletteCss", () => {
  it("emite regra para claro e para .dark, restrita ao escopo", () => {
    const css = chartPaletteCss(resolveChartPalette("grove")!)
    expect(css).toContain('[data-chart-palette="grove"]{--chart-1:oklch(0.596 0.145 163.225);')
    expect(css).toContain('.dark [data-chart-palette="grove"]{--chart-1:oklch(0.765 0.177 163.223);')
    expect(css).toContain("--chart-6:")
    expect(css).toContain("--chart-positive:")
  })
})
