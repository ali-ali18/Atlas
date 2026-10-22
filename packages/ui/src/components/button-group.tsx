import { cn } from "cn"

/**
 * Botões colados lado a lado: só as pontas do grupo ficam arredondadas e a borda do meio é uma só.
 * As pontas ignoram os focus guards (`span[data-base-ui-focus-guard]`) que o Base UI põe ao redor do
 * gatilho de um menu aberto; com `:first-child`/`:last-child` o gatilho perdia o arredondado.
 */
function ButtonGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      role="group"
      data-slot="button-group"
      className={cn(
        "flex w-fit shrink-0 items-stretch [&>*]:focus-visible:relative [&>*]:focus-visible:z-10",
        "[&>*:not(:nth-child(1_of_:not([data-base-ui-focus-guard])))]:rounded-l-none [&>*:not(:nth-child(1_of_:not([data-base-ui-focus-guard])))]:border-l-0",
        "[&>*:not(:nth-last-child(1_of_:not([data-base-ui-focus-guard])))]:rounded-r-none",
        className
      )}
      {...props}
    />
  )
}

export { ButtonGroup }
