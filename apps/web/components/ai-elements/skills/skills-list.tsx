"use client";

import { Marker, MarkerContent } from "@workspace/ui/components/marker";
import { cn } from "@workspace/ui/lib/utils";
import { PencilLineIcon, SparklesIcon } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { createContext, useContext, useMemo } from "react";
import type { SkillListItemData } from "@workspace/shared";

// ============================================================================
// Types
// ============================================================================

export type { SkillListItemData };

export type SkillsVariant = "list";

// ============================================================================
// Contexts
// ============================================================================

interface SkillsContextValue {
  variant: SkillsVariant;
}

const SkillsContext = createContext<SkillsContextValue | null>(null);

interface SkillContextValue {
  data: SkillListItemData;
  variant: SkillsVariant;
}

const SkillContext = createContext<SkillContextValue | null>(null);

// ============================================================================
// Hooks
// ============================================================================

export const useSkillsContext = () =>
  useContext(SkillsContext) ?? { variant: "list" as const };

export const useSkillContext = () => {
  const ctx = useContext(SkillContext);
  if (!ctx) {
    throw new Error("Skill components must be used within <Skill>");
  }
  return ctx;
};

// ============================================================================
// Skills - Container
// ============================================================================

export type SkillsProps = HTMLAttributes<HTMLDivElement> & {
  variant?: SkillsVariant;
};

export const Skills = ({
  variant = "list",
  className,
  children,
  ...props
}: SkillsProps) => {
  const contextValue = useMemo(() => ({ variant }), [variant]);

  return (
    <SkillsContext.Provider value={contextValue}>
      <div
        className={cn("flex w-full flex-col gap-1", className)}
        {...props}
      >
        {children}
      </div>
    </SkillsContext.Provider>
  );
};

// ============================================================================
// Skill - Item
// ============================================================================

export type SkillProps = HTMLAttributes<HTMLDivElement> & {
  data: SkillListItemData;
};

export const Skill = ({
  data,
  className,
  children,
  ...props
}: SkillProps) => {
  const { variant } = useSkillsContext();

  const contextValue = useMemo<SkillContextValue>(
    () => ({ data, variant }),
    [data, variant]
  );

  return (
    <SkillContext.Provider value={contextValue}>
      <div
        className={cn(
          "flex w-full items-center gap-3 rounded-xl px-2 py-2",
          data.status === "draft" && "opacity-70",
          className
        )}
        {...props}
      >
        {children}
      </div>
    </SkillContext.Provider>
  );
};

// ============================================================================
// SkillIcon
// ============================================================================

export type SkillIconProps = HTMLAttributes<HTMLSpanElement>;

export const SkillIcon = ({ className, ...props }: SkillIconProps) => {
  const { data } = useSkillContext();
  const Icon = data.status === "draft" ? PencilLineIcon : SparklesIcon;

  return (
    <span
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary",
        className
      )}
      {...props}
    >
      <Icon className="size-4" />
    </span>
  );
};

// ============================================================================
// SkillInfo - Name and meta display
// ============================================================================

export type SkillInfoProps = HTMLAttributes<HTMLDivElement> & {
  showDescription?: boolean;
};

export const SkillInfo = ({
  showDescription = true,
  className,
  ...props
}: SkillInfoProps) => {
  const { data } = useSkillContext();

  return (
    <div className={cn("min-w-0 flex-1", className)} {...props}>
      <span className="block truncate font-medium text-sm">{data.title}</span>
      <span className="block truncate text-muted-foreground text-xs">
        {data.capabilityKey} (v{data.versionNumber})
        {data.status === "draft" ? " • rascunho" : ""}
      </span>
      {showDescription && data.description ? (
        <span className="block truncate text-muted-foreground text-xs">
          {data.description}
        </span>
      ) : null}
    </div>
  );
};

// ============================================================================
// SkillsDraftSeparator - Marker divisor para rascunhos
// ============================================================================

export type SkillsDraftSeparatorProps = HTMLAttributes<HTMLDivElement> & {
  children?: ReactNode;
};

export const SkillsDraftSeparator = ({
  children,
  className,
  ...props
}: SkillsDraftSeparatorProps) => (
  <Marker variant="separator" className={className} {...props}>
    <MarkerContent className="text-muted-foreground text-xs">
      {children ?? "Rascunhos"}
    </MarkerContent>
  </Marker>
);

// ============================================================================
// SkillsList - composição pronta (ativas + separador + rascunhos)
// ============================================================================

export type SkillsListProps = HTMLAttributes<HTMLDivElement> & {
  items: SkillListItemData[];
  draftCount?: number;
};

export const SkillsList = ({
  items,
  draftCount,
  className,
  ...props
}: SkillsListProps) => {
  const actives = items.filter((item) => item.status === "active");
  const drafts = items.filter((item) => item.status === "draft");
  const extraDrafts =
    typeof draftCount === "number" && draftCount > drafts.length
      ? draftCount - drafts.length
      : 0;

  if (items.length === 0) {
    return (
      <div className="text-muted-foreground text-xs">
        Você ainda não tem skills ativas...
      </div>
    );
  }

  return (
    <Skills
      className={cn("w-full rounded-2xl border bg-card p-2", className)}
      {...props}
    >
      {actives.map((item) => (
        <Skill key={item.capabilityKey} data={item}>
          <SkillIcon />
          <SkillInfo />
        </Skill>
      ))}
      {drafts.length > 0 ? (
        <>
          <SkillsDraftSeparator />
          {drafts.map((item) => (
            <Skill key={item.capabilityKey} data={item}>
              <SkillIcon />
              <SkillInfo />
            </Skill>
          ))}
        </>
      ) : null}
      {extraDrafts > 0 ? (
        <span className="px-2 text-muted-foreground text-xs">
          + {extraDrafts} rascunho(s) aguardando repetição.
        </span>
      ) : null}
    </Skills>
  );
};
