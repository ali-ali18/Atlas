import { prisma } from "./client.js";

export type UserProfile = { id: string; name: string; email: string; image: string | null };

const SELECT = { id: true, name: true, email: true, image: true } as const;

/** Atualiza só nome e/ou foto do próprio usuário (`image: null` remove a foto). */
export async function updateUserProfile(
	userId: string,
	patch: { name?: string; image?: string | null },
): Promise<UserProfile> {
	const data: { name?: string; image?: string | null } = {};
	if (patch.name !== undefined) data.name = patch.name;
	if (patch.image !== undefined) data.image = patch.image;
	return prisma.user.update({ where: { id: userId }, data, select: SELECT });
}
