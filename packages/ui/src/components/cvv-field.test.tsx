import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { CvvField } from "./cvv-field"

describe("CvvField", () => {
  const html = renderToStaticMarkup(<CvvField hint="3 dígitos no verso. Não é guardado." label="Código de segurança (CVV)" />)

  it("campo numérico mascarado, 3 a 4 dígitos, com a dica de autopreenchimento de cartão", () => {
    expect(html).toContain('type="password"')
    expect(html).toContain('inputMode="numeric"')
    expect(html).toContain('autoComplete="cc-csc"')
    expect(html).toContain('maxLength="4"')
    expect(html).toContain("Código de segurança (CVV)")
  })

  it("sem name (não entra em formulário), sem value, e gerenciadores de senha ignoram", () => {
    expect(html).not.toMatch(/\sname=/)
    expect(html).not.toMatch(/\svalue=/)
    expect(html).toContain('data-1p-ignore="true"')
    expect(html).toContain('data-lpignore="true"')
  })

  it("rótulo ligado ao campo e erro anunciado", () => {
    const withError = renderToStaticMarkup(<CvvField error="Digite 3 ou 4 números." id="c1" label="CVV" />)
    expect(withError).toContain('for="c1"')
    expect(withError).toContain('aria-invalid="true"')
    expect(withError).toContain('role="alert"')
  })
})
