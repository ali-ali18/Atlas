"use client";

import { Skeleton } from "@workspace/ui/components/skeleton";

/** Espelha o layout das mensagens (assistant à esquerda, user à direita). */
export function ThreadSkeleton() {
	return (
		<div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8">
			<div className="flex items-start gap-2.5">
				<Skeleton className="size-9 shrink-0 rounded-full" />
				<div className="flex min-w-0 flex-1 flex-col gap-2 pt-1.5">
					<Skeleton className="h-3.5 w-[85%]" />
					<Skeleton className="h-3.5 w-[72%]" />
					<Skeleton className="h-3.5 w-[48%]" />
				</div>
			</div>

			<Skeleton className="ml-auto h-9 w-44 rounded-3xl" />

			<div className="flex items-start gap-2.5">
				<Skeleton className="size-9 shrink-0 rounded-full" />
				<div className="flex min-w-0 flex-1 flex-col gap-2 pt-1.5">
					<Skeleton className="h-3.5 w-[78%]" />
					<Skeleton className="h-3.5 w-[55%]" />
				</div>
			</div>
		</div>
	);
}
