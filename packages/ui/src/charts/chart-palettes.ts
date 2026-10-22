import {
  CHART_CUSTOM_COLORS_MAX,
  normalizeChartHexColor,
  type ChartPalette,
} from "@workspace/shared"

/**
 * Paletas de gráfico: cada uma define `--chart-1..6` e as cores de tendência para tema claro e escuro.
 * `chart-6` é acréscimo do Atlas (o Bklit UI traz 5 cores); as demais vêm do upstream.
 * Sem paleta, os gráficos usam os tokens padrão de `globals.css`.
 */

export type PresetPaletteId = Exclude<ChartPalette, "custom">

export type PaletteColors = {
  series: [string, string, string, string, string, string]
  positive: string
  negative: string
}

export type ResolvedPalette = {
  /** Valor de `data-chart-palette` e escopo do CSS gerado. */
  scope: string
  light: PaletteColors
  dark: PaletteColors
}

const TREND_LIGHT = { positive: "oklch(0.696 0.17 162.48)", negative: "oklch(0.637 0.237 25.331)" }
const TREND_DARK = { positive: "oklch(0.765 0.177 163.223)", negative: "oklch(0.704 0.191 22.216)" }

export const CHART_PALETTE_LABELS: Record<PresetPaletteId, string> = {
  primary: "Primária",
  monochrome: "Monocromática",
  ocean: "Oceano",
  sunset: "Pôr do sol",
  grove: "Bosque",
  vivid: "Vívida",
}

export const PRESET_PALETTES: Record<PresetPaletteId, Omit<ResolvedPalette, "scope">> = {
  primary: {
    light: {
      series: [
        "oklch(0.585 0.233 277.117)", // indigo
        "oklch(0.852 0.199 91.936)", // amarelo
        "oklch(0.667 0.295 322.15)", // fúcsia
        "oklch(0.56 0.021 213.5)", // névoa
        "oklch(0 0 0)", // preto
        "oklch(0.696 0.17 162.48)", // esmeralda (Atlas)
      ],
      ...TREND_LIGHT,
    },
    dark: {
      series: [
        "oklch(0.585 0.233 277.117)",
        "oklch(0.852 0.199 91.936)",
        "oklch(0.667 0.295 322.15)",
        "oklch(0.56 0.021 213.5)",
        "oklch(1 0 0)", // branco
        "oklch(0.765 0.177 163.223)",
      ],
      ...TREND_DARK,
    },
  },
  monochrome: {
    light: {
      series: [
        "oklch(0.268 0.007 34.298)",
        "oklch(0.444 0.011 73.639)",
        "oklch(0.709 0.01 56.259)",
        "oklch(0.869 0.005 56.366)",
        "oklch(0.923 0.003 48.717)",
        "oklch(0.553 0.013 58.071)",
      ],
      ...TREND_LIGHT,
    },
    dark: {
      series: [
        "oklch(0.967 0.001 286.375)",
        "oklch(0.871 0.006 286.286)",
        "oklch(0.705 0.015 286.067)",
        "oklch(0.552 0.016 285.938)",
        "oklch(0.442 0.017 285.786)",
        "oklch(0.37 0.013 285.805)",
      ],
      ...TREND_DARK,
    },
  },
  ocean: {
    light: {
      series: [
        "oklch(0.546 0.245 262.881)",
        "oklch(0.715 0.143 215.221)",
        "oklch(0.777 0.152 181.912)",
        "oklch(0.673 0.182 276.935)",
        "oklch(0.828 0.111 230.318)",
        "oklch(0.809 0.105 251.813)",
      ],
      ...TREND_LIGHT,
    },
    dark: {
      series: [
        "oklch(0.623 0.214 259.815)",
        "oklch(0.789 0.154 211.53)",
        "oklch(0.855 0.138 181.071)",
        "oklch(0.785 0.115 274.713)",
        "oklch(0.901 0.058 230.902)",
        "oklch(0.882 0.059 254.128)",
      ],
      ...TREND_DARK,
    },
  },
  sunset: {
    light: {
      series: [
        "oklch(0.705 0.213 47.604)",
        "oklch(0.645 0.246 16.439)",
        "oklch(0.828 0.189 84.429)",
        "oklch(0.627 0.265 303.9)",
        "oklch(0.823 0.12 346.018)",
        "oklch(0.637 0.237 25.331)",
      ],
      ...TREND_LIGHT,
    },
    dark: {
      series: [
        "oklch(0.75 0.183 55.934)",
        "oklch(0.712 0.194 13.428)",
        "oklch(0.879 0.169 91.605)",
        "oklch(0.714 0.203 305.504)",
        "oklch(0.899 0.061 343.231)",
        "oklch(0.704 0.191 22.216)",
      ],
      ...TREND_DARK,
    },
  },
  grove: {
    light: {
      series: [
        "oklch(0.596 0.145 163.225)",
        "oklch(0.768 0.233 130.85)",
        "oklch(0.511 0.096 186.391)",
        "oklch(0.769 0.188 70.08)",
        "oklch(0.709 0.01 56.259)",
        "oklch(0.532 0.157 131.589)",
      ],
      ...TREND_LIGHT,
    },
    dark: {
      series: [
        "oklch(0.765 0.177 163.223)",
        "oklch(0.841 0.238 128.85)",
        "oklch(0.6 0.118 184.704)",
        "oklch(0.828 0.189 84.429)",
        "oklch(0.709 0.01 56.259)",
        "oklch(0.648 0.2 131.684)",
      ],
      ...TREND_DARK,
    },
  },
  vivid: {
    light: {
      series: [
        "oklch(0.606 0.25 292.717)",
        "oklch(0.656 0.241 354.308)",
        "oklch(0.715 0.143 215.221)",
        "oklch(0.768 0.233 130.85)",
        "oklch(0.705 0.213 47.604)",
        "oklch(0.623 0.214 259.815)",
      ],
      ...TREND_LIGHT,
    },
    dark: {
      series: [
        "oklch(0.702 0.183 293.541)",
        "oklch(0.718 0.202 349.761)",
        "oklch(0.865 0.127 207.078)",
        "oklch(0.897 0.196 126.665)",
        "oklch(0.75 0.183 55.934)",
        "oklch(0.707 0.165 254.624)",
      ],
      ...TREND_DARK,
    },
  },
}

export const PRESET_PALETTE_IDS = Object.keys(PRESET_PALETTES) as PresetPaletteId[]

// ---- Paleta personalizada: hex → cores legíveis nos dois temas ----

/** Fundo do cartão do gráfico em cada tema (aproximação sRGB de `--card`). */
const LIGHT_SURFACE = "#ffffff"
const DARK_SURFACE = "#18181b"
/** Contraste mínimo de elementos gráficos contra o fundo (WCAG 1.4.11 pede 3:1). */
export const MIN_GRAPHIC_CONTRAST = 3

type Rgb = [number, number, number]

function hexToRgb(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function rgbToHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((channel) => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as Rgb
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0)
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  return [h * 60, s, l]
}

function hslToRgb([h, s, l]: [number, number, number]): Rgb {
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [f(0) * 255, f(8) * 255, f(4) * 255]
}

/**
 * Ajusta só a luminosidade (matiz e saturação preservados) até a cor atingir o contraste mínimo contra o fundo:
 * escurece no tema claro, clareia no escuro. Cor que já passa não muda.
 */
export function ensureContrast(hex: string, surface: string, min = MIN_GRAPHIC_CONTRAST): string {
  if (contrastRatio(hex, surface) >= min) return hex
  const [h, s, l] = rgbToHsl(hexToRgb(hex))
  const surfaceIsLight = relativeLuminance(surface) > 0.5
  const step = surfaceIsLight ? -0.01 : 0.01
  let next = l
  for (let i = 0; i < 100; i += 1) {
    next = Math.min(1, Math.max(0, next + step))
    const candidate = rgbToHex(hslToRgb([h, s, next]))
    if (contrastRatio(candidate, surface) >= min) return candidate
    if (next <= 0 || next >= 1) break
  }
  return rgbToHex(hslToRgb([h, s, surfaceIsLight ? 0 : 1]))
}

function hashColors(colors: string[]): string {
  let hash = 5381
  for (const char of colors.join(",")) hash = ((hash * 33) ^ char.charCodeAt(0)) >>> 0
  return hash.toString(36)
}

export type CustomPaletteResult =
  | { ok: true; palette: ResolvedPalette }
  | { ok: false; error: string }

/**
 * Valida e prepara uma paleta personalizada. Mais de 6 cores são rejeitadas; menos de 6 repetem em ciclo.
 * Cada cor é ajustada para ficar legível (contraste ≥ 3:1) no tema claro e no escuro.
 */
export function buildCustomPalette(input: readonly unknown[]): CustomPaletteResult {
  if (input.length < 1 || input.length > CHART_CUSTOM_COLORS_MAX) {
    return { ok: false, error: `use de 1 a ${CHART_CUSTOM_COLORS_MAX} cores` }
  }
  const colors: string[] = []
  for (const [index, raw] of input.entries()) {
    const hex = normalizeChartHexColor(raw)
    if (!hex) return { ok: false, error: `cor ${index + 1} inválida: use hexadecimal como #2563eb` }
    colors.push(hex)
  }
  const cycle = (surface: string) =>
    Array.from({ length: 6 }, (_, index) => ensureContrast(colors[index % colors.length]!, surface)) as PaletteColors["series"]
  return {
    ok: true,
    palette: {
      scope: `custom-${hashColors(colors)}`,
      light: { series: cycle(LIGHT_SURFACE), ...TREND_LIGHT },
      dark: { series: cycle(DARK_SURFACE), ...TREND_DARK },
    },
  }
}

/** Paleta do spec: `undefined` = visual padrão (nada a aplicar); `custom` inválida também cai no padrão. */
export function resolveChartPalette(palette: ChartPalette | undefined, colors?: readonly string[]): ResolvedPalette | undefined {
  if (!palette) return undefined
  if (palette === "custom") {
    const built = buildCustomPalette(colors ?? [])
    return built.ok ? built.palette : undefined
  }
  const preset = PRESET_PALETTES[palette]
  return preset ? { scope: palette, ...preset } : undefined
}

function declarations(colors: PaletteColors): string {
  const series = colors.series.map((color, index) => `--chart-${index + 1}:${color};`).join("")
  // Tokens derivados de --chart-1/2 são resolvidos em :root; dentro do escopo precisam ser refeitos para seguir a paleta.
  const derived =
    "--chart-line-primary:var(--chart-1);--chart-line-secondary:var(--chart-2);" +
    "--chart-indicator-color:var(--chart-1);--chart-indicator-secondary-color:var(--chart-2);" +
    "--chart-scale-02:color-mix(in oklab,var(--chart-1) 35%,var(--chart-scale-mix));" +
    "--chart-scale-03:color-mix(in oklab,var(--chart-1) 55%,var(--chart-scale-mix));" +
    "--chart-scale-04:color-mix(in oklab,var(--chart-1) 78%,var(--chart-scale-mix));" +
    "--chart-scale-05:var(--chart-1);"
  return `${series}--chart-positive:${colors.positive};--chart-negative:${colors.negative};${derived}`
}

/**
 * CSS que aplica a paleta só dentro de `[data-chart-palette="<scope>"]`, com valores próprios para `.dark`.
 * O escopo vem de ids fixos ou de um hash, nunca de texto livre, então o CSS gerado é seguro de injetar.
 */
export function chartPaletteCss(palette: ResolvedPalette): string {
  const selector = `[data-chart-palette="${palette.scope}"]`
  return `${selector}{${declarations(palette.light)}}.dark ${selector}{${declarations(palette.dark)}}`
}
