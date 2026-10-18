"use client";

import { Skeleton } from "@workspace/ui/components/skeleton";
import {
	SidebarGroup,
	SidebarGroupContent,
	SidebarMenu,
	SidebarMenuItem,
} from "@workspace/ui/components/sidebar";

/** Espelha as linhas da lista de agentes enquanto os bots carregam. */
export function AgentsSkeleton({ count = 6 }: { count?: number }) {
	return (
		<SidebarGroup>
			<SidebarGroupContent>
				<SidebarMenu>
					{Array.from({ length: count }).map((_, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: skeleton estático
						<SidebarMenuItem key={index}>
							<div className="flex items-center gap-2.5 rounded-xl px-3 py-2">
								<Skeleton className="size-[52px] shrink-0 rounded-full" />
								<div className="flex min-w-0 flex-1 flex-col gap-1.5">
									<div className="flex items-center justify-between gap-2">
										<Skeleton className="h-3.5 w-24" />
										<Skeleton className="h-2.5 w-8" />
									</div>
									<Skeleton className="h-3 w-32" />
								</div>
							</div>
						</SidebarMenuItem>
					))}
				</SidebarMenu>
			</SidebarGroupContent>
		</SidebarGroup>
	);
}
