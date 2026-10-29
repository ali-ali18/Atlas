import { cn } from "../lib/utils"

/**
 * Botões colados lado a lado: só as pontas do grupo ficam arredondadas e a borda do meio é uma só.
 * As pontas contam só os filhos com `data-slot` (nossos primitivos): com o menu aberto o Base UI põe
 * spans ao redor do gatilho (focus guards e um `aria-owns`), e com `:last-child` ele perdia o arredondado.
 */
function ButtonGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      role="group"
      data-slot="button-group"
      className={cn(
        "flex w-fit shrink-0 items-stretch [&>*]:focus-visible:relative [&>*]:focus-visible:z-10",
        "[&>*:not(:nth-child(1_of_[data-slot]))]:rounded-l-none [&>*:not(:nth-child(1_of_[data-slot]))]:border-l-0",
        "[&>*:not(:nth-last-child(1_of_[data-slot]))]:rounded-r-none",
        className
      )}
      {...props}
    />
  )
}

export { ButtonGroup }
