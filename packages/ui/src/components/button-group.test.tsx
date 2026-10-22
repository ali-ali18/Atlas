import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ButtonGroup } from "./button-group"

describe("ButtonGroup", () => {
  it("as pontas ignoram os focus guards do Base UI (menu aberto não deixa o gatilho quadrado)", () => {
    const html = renderToStaticMarkup(<ButtonGroup><button type="button">A</button></ButtonGroup>)
    expect(html).toContain("[&amp;&gt;*:not(:nth-last-child(1_of_:not([data-base-ui-focus-guard])))]:rounded-r-none")
    expect(html).toContain("[&amp;&gt;*:not(:nth-child(1_of_:not([data-base-ui-focus-guard])))]:rounded-l-none")
    expect(html).not.toContain(":not(:last-child)")
  })
})
