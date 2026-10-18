import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8")

describe("overlays modais (sheet, dialog, alert-dialog)", () => {
  for (const file of ["sheet.tsx", "dialog.tsx", "alert-dialog.tsx"]) {
    it(`${file}: sempre renderiza o fundo escurecido e desfocado`, () => {
      const src = read(file)
      expect(src).toContain("bg-black/50")
      // diálogo aninhado também desenha o fundo (senão a folha empilhada não escurece o que está embaixo)
      expect(src).toContain("forceRender")
      expect(src).toContain("supports-backdrop-filter:bg-black/40")
      expect(src).toContain("supports-backdrop-filter:backdrop-blur-sm")
      // blur leve (4px): sem blur grande, barato no Android
      expect(src).not.toMatch(/backdrop-blur-(md|lg|xl|2xl|3xl)/)
    })
    it(`${file}: não bloqueia o toque fora nem o Esc`, () => {
      const src = read(file)
      expect(src).not.toContain("disablePointerDismissal")
      expect(src).not.toMatch(/modal=\{false\}/)
    })
  }

  it("sheet: o fundo fica fora do popup (toque nele fecha) e o popup tem z acima", () => {
    const src = read("sheet.tsx")
    expect(src.indexOf("<SheetOverlay />")).toBeLessThan(src.indexOf("<SheetPrimitive.Popup"))
  })
})
