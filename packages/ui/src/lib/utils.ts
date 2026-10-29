import { createCn } from "cn/config"
import type { ClassValue } from "cn"

/**
 * `cn` com os tokens do tema (globals.css). Sem isso o merge trata `text-body`
 * como COR e apaga a cor vizinha (ex.: `text-muted-foreground`), e não resolve
 * conflito entre `text-body` e `text-sm`.
 */
const merge = createCn({
  extend: {
    classGroups: {
      "font-size": [{ text: ["body", "caption"] }],
      rounded: [{ rounded: ["card", "panel"] }],
    },
  },
})

export function cn(...inputs: ClassValue[]): string {
  return merge(...inputs)
}
