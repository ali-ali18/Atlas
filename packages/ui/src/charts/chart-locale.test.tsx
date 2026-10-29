import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"
import { DEFAULT_UI_COPY, UiCopyProvider } from "../components/ui-copy"
import { avatarInitial } from "../components/gradient-avatar"
import { describeReference, makeValueFormatter, makeXLabels } from "../components/chart"
import { getChartLocale, intFmt, setChartLocale, shortDateFmt, useChartLocale } from "./chart-formatters"

const plain = (text: string) => text.replace(/\s/g, " ")

afterEach(() => setChartLocale("pt-BR"))

describe("idioma dos gráficos", () => {
  it("padrão é pt-BR e os formatos antigos não mudam", () => {
    expect(getChartLocale()).toBe("pt-BR")
    expect(intFmt(1234567)).toBe("1.234.567")
    expect(shortDateFmt.format(new Date(2026, 9, 3))).toBe("03/10")
    expect(plain(makeValueFormatter({ unit: "BRL" })(1234.5))).toBe("R$ 1.234,50")
    expect(makeXLabels({ type: "line", x: "d", xKind: "date", series: [{ key: "v" }], data: [{ d: "2025-01-01", v: 1 }, { d: "2025-02-01", v: 2 }] } as never).axis("2025-01-01")).toBe("jan/25")
  })

  it("segue o idioma registrado (en-US e es-ES)", () => {
    setChartLocale("en-US")
    expect(intFmt(1234567)).toBe("1,234,567")
    expect(shortDateFmt.format(new Date(2026, 9, 3))).toBe("10/03")
    expect(plain(makeValueFormatter({ unit: "BRL" })(1234.5))).toMatch(/R\$\s?1,234\.50/)
    const monthly = { type: "line", x: "d", xKind: "date", series: [{ key: "v" }], data: [{ d: "2025-01-01", v: 1 }, { d: "2025-02-01", v: 2 }] } as never
    expect(makeXLabels(monthly).axis("2025-01-01")).toBe("Jan/25")
    expect(makeXLabels(monthly).title("2025-01-01")).toBe("January 2025")
    setChartLocale("es-ES")
    expect(makeXLabels(monthly).title("2025-01-01")).toBe("enero de 2025")
  })

  it("UiCopyProvider entrega o idioma por contexto (sem variável global) e traduz a legenda da meta", () => {
    const copy = { locale: "en-US", chartFrom: "from {value}", chartUpTo: "up to {value}" }
    function Probe() {
      return <span>{`${useChartLocale()}|${intFmt(1234567, useChartLocale())}`}</span>
    }
    expect(renderToStaticMarkup(<UiCopyProvider copy={copy}><Probe /></UiCopyProvider>)).toContain("en-US|1,234,567")
    expect(renderToStaticMarkup(<UiCopyProvider copy={{ locale: "es-ES" }}><Probe /></UiCopyProvider>)).toContain("es-ES|1.234.567")
    // Renderizar com um provider não muda o padrão de quem formata fora de um (outra requisição no servidor).
    expect(getChartLocale()).toBe("pt-BR")
    expect(renderToStaticMarkup(<Probe />)).toContain("pt-BR|1.234.567")
    const spec = { unit: "%", reference: { from: 10 } } as never
    expect(describeReference(spec, { ...DEFAULT_UI_COPY, ...copy })).toBe("from 10%")
    expect(describeReference({ unit: "%", reference: { to: 5 } } as never)).toBe("até 5%")
  })

  it("gráfico dentro do provider formata no idioma dele, sem tocar no padrão global", () => {
    const spec = { type: "line", x: "d", xKind: "date", series: [{ key: "v" }], data: [{ d: "2025-01-01", v: 1 }, { d: "2025-02-01", v: 2 }] } as never
    expect(makeXLabels(spec, "en-US").title("2025-01-01")).toBe("January 2025")
    expect(makeXLabels(spec).title("2025-01-01")).toBe("janeiro de 2025")
    expect(plain(makeValueFormatter({ unit: "BRL" }, { locale: "en-US" })(1234.5))).toMatch(/R\$\s?1,234\.50/)
    expect(getChartLocale()).toBe("pt-BR")
  })

  it("inicial do avatar usa o idioma (i turco vira İ)", () => {
    expect(avatarInitial("istanbul", null, "tr-TR")).toBe("İ")
    expect(avatarInitial("istanbul", null, "pt-BR")).toBe("I")
    setChartLocale("tr-TR")
    expect(avatarInitial("istanbul")).toBe("İ")
  })
})
