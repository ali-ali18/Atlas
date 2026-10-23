import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ButtonGroup } from "./button-group"

describe("ButtonGroup", () => {
  it("as pontas contam só os filhos com data-slot, ignorando os spans do Base UI (menu aberto não deixa o gatilho quadrado)", () => {
    const html = renderToStaticMarkup(<ButtonGroup><button type="button">A</button></ButtonGroup>)
    expect(html).toContain("[&amp;&gt;*:not(:nth-last-child(1_of_[data-slot]))]:rounded-r-none")
    expect(html).toContain("[&amp;&gt;*:not(:nth-child(1_of_[data-slot]))]:rounded-l-none")
    expect(html).not.toContain(":not(:last-child)")
  })
})
