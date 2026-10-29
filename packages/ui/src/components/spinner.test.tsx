import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { Spinner } from "./spinner"

describe("Spinner", () => {
  it("sem rótulo é decorativo e só gira com motion-safe", () => {
    const html = renderToStaticMarkup(<Spinner />)
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain("motion-safe:animate-spin")
    expect(html).not.toContain("role=")
  })

  it("com rótulo vira status acessível e aceita tamanho por className", () => {
    const html = renderToStaticMarkup(<Spinner className="size-5" label="Em andamento" />)
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-label="Em andamento"')
    expect(html).toContain("size-5")
    expect(html).not.toContain("size-4")
  })
})
