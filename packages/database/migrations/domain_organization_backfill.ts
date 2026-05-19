import { db } from "@cap/database";
import {
	folders,
	importedVideos,
	notifications,
	organizationInvites,
	organizationMembers,
	organizations,
	s3Buckets,
	sharedVideos,
	spaceMembers,
	spaces,
	spaceVideos,
	storageIntegrations,
	users,
	videos,
} from "@cap/database/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { extractDomainFromEmail } from "../auth/domain-utils.ts";

type UserId = typeof users.$inferSelect.id;
type OrganizationId = typeof organizations.$inferSelect.id;
type SpaceOrOrganizationId = typeof spaces.$inferSelect.id;

type DomainUser = {
	id: UserId;
	email: string;
	activeOrganizationId: OrganizationId | null;
	defaultOrganizationId: OrganizationId | null;
	thirdPartyStripeSubscriptionId: string | null;
	stripeSubscriptionId: string | null;
	inviteQuota: number;
};

type MembershipRow = {
	organizationId: OrganizationId;
	userId: UserId;
	role: "owner" | "admin" | "member";
	hasProSeat: boolean;
	email: string;
};

function normalizeDomain(email: string) {
	return extractDomainFromEmail(email)?.toLowerCase() ?? null;
}

function getPrimaryOrgId(user: DomainUser) {
	return user.defaultOrganizationId ?? user.activeOrganizationId;
}

function resolveTargetRole(
	userId: UserId,
	canonicalOwnerId: UserId,
	sourceOwnerIds: Set<UserId>,
	existingRole: MembershipRow["role"] | undefined,
) {
	if (userId === canonicalOwnerId) return "owner";
	if (
		existingRole === "owner" ||
		existingRole === "admin" ||
		sourceOwnerIds.has(userId)
	) {
		return "admin";
	}
	return "member";
}

async function mergeDomainOrganizations(
	domain: string,
	usersForDomain: DomainUser[],
) {
	const orgIds: OrganizationId[] = [
		...new Set(
			usersForDomain
				.map((user) => getPrimaryOrgId(user))
				.filter((orgId): orgId is OrganizationId => orgId !== null),
		),
	];

	if (orgIds.length === 0) {
		return;
	}

	const orgRows = await db()
		.select({
			id: organizations.id,
			ownerId: organizations.ownerId,
			name: organizations.name,
			allowedEmailDomain: organizations.allowedEmailDomain,
			createdAt: organizations.createdAt,
			tombstoneAt: organizations.tombstoneAt,
		})
		.from(organizations)
		.where(inArray(organizations.id, orgIds));

	const liveOrgs = orgRows.filter((org) => !org.tombstoneAt);
	if (liveOrgs.length === 0) {
		return;
	}

	const membershipRows = await db()
		.select({
			organizationId: organizationMembers.organizationId,
			userId: organizationMembers.userId,
			role: organizationMembers.role,
			hasProSeat: organizationMembers.hasProSeat,
			email: users.email,
		})
		.from(organizationMembers)
		.innerJoin(users, eq(organizationMembers.userId, users.id))
		.where(
			inArray(
				organizationMembers.organizationId,
				liveOrgs.map((org) => org.id),
			),
		);

	const orgsById = new Map(liveOrgs.map((org) => [org.id, org]));
	const membershipsByOrg = new Map<string, MembershipRow[]>();
	for (const membership of membershipRows) {
		const current = membershipsByOrg.get(membership.organizationId) ?? [];
		current.push(membership);
		membershipsByOrg.set(membership.organizationId, current);
	}

	for (const org of liveOrgs) {
		const members = membershipsByOrg.get(org.id) ?? [];
		const hasForeignDomainMember = members.some(
			(member) => normalizeDomain(member.email) !== domain,
		);
		if (hasForeignDomainMember) {
			console.log(
				`⏭️ Skipping domain ${domain}: organization ${org.id} has mixed-domain members`,
			);
			return;
		}
	}

	const canonicalOrg = [...liveOrgs].sort(
		(left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
	)[0];

	if (!canonicalOrg) {
		return;
	}

	const sourceOrgIds: OrganizationId[] = liveOrgs
		.map((org) => org.id)
		.filter((orgId) => orgId !== canonicalOrg.id);

	const sourceOwnerIds = new Set<UserId>(
		sourceOrgIds
			.map((orgId) => orgsById.get(orgId)?.ownerId)
			.filter((ownerId): ownerId is UserId => Boolean(ownerId)),
	);

	const canonicalMemberships = membershipsByOrg.get(canonicalOrg.id) ?? [];
	const canonicalMembershipMap = new Map(
		canonicalMemberships.map((membership) => [membership.userId, membership]),
	);

	await db().transaction(async (tx) => {
		if (canonicalOrg.allowedEmailDomain !== domain) {
			await tx
				.update(organizations)
				.set({ allowedEmailDomain: domain })
				.where(eq(organizations.id, canonicalOrg.id));
		}

		for (const user of usersForDomain) {
			const existingCanonicalMembership = canonicalMembershipMap.get(user.id);
			const targetRole = resolveTargetRole(
				user.id,
				canonicalOrg.ownerId,
				sourceOwnerIds,
				existingCanonicalMembership?.role,
			);
			const preserveProSeat =
				existingCanonicalMembership?.hasProSeat ??
				membershipRows.find((membership) => membership.userId === user.id)
					?.hasProSeat ??
				false;

			if (existingCanonicalMembership) {
				if (
					targetRole !== existingCanonicalMembership.role ||
					preserveProSeat !== existingCanonicalMembership.hasProSeat
				) {
					await tx
						.update(organizationMembers)
						.set({ role: targetRole, hasProSeat: preserveProSeat })
						.where(
							and(
								eq(organizationMembers.organizationId, canonicalOrg.id),
								eq(organizationMembers.userId, user.id),
							),
						);
				}
			} else {
				await tx.insert(organizationMembers).values({
					id: sql`substring(replace(uuid(), '-', ''), 1, 15)`,
					organizationId: canonicalOrg.id,
					userId: user.id,
					role: targetRole,
					hasProSeat: preserveProSeat,
				});
			}
		}

		await tx
			.update(users)
			.set({
				activeOrganizationId: canonicalOrg.id,
				defaultOrgId: canonicalOrg.id,
			})
			.where(
				inArray(
					users.id,
					usersForDomain.map((user) => user.id),
				),
			);

		if (sourceOrgIds.length > 0) {
			await tx
				.update(videos)
				.set({ orgId: canonicalOrg.id })
				.where(inArray(videos.orgId, sourceOrgIds));

			await tx
				.update(notifications)
				.set({ orgId: canonicalOrg.id })
				.where(inArray(notifications.orgId, sourceOrgIds));

			await tx
				.update(importedVideos)
				.set({ orgId: canonicalOrg.id })
				.where(inArray(importedVideos.orgId, sourceOrgIds));

			await tx
				.update(organizationInvites)
				.set({ organizationId: canonicalOrg.id })
				.where(inArray(organizationInvites.organizationId, sourceOrgIds));

			await tx
				.update(sharedVideos)
				.set({ organizationId: canonicalOrg.id })
				.where(inArray(sharedVideos.organizationId, sourceOrgIds));

			await tx
				.update(folders)
				.set({ organizationId: canonicalOrg.id })
				.where(inArray(folders.organizationId, sourceOrgIds));

			await tx
				.update(folders)
				.set({ spaceId: canonicalOrg.id as SpaceOrOrganizationId })
				.where(
					inArray(folders.spaceId, sourceOrgIds as SpaceOrOrganizationId[]),
				);

			await tx
				.update(spaces)
				.set({ organizationId: canonicalOrg.id })
				.where(inArray(spaces.organizationId, sourceOrgIds));

			await tx
				.update(spaceMembers)
				.set({ spaceId: canonicalOrg.id as SpaceOrOrganizationId })
				.where(
					inArray(
						spaceMembers.spaceId,
						sourceOrgIds as SpaceOrOrganizationId[],
					),
				);

			await tx
				.update(spaceVideos)
				.set({ spaceId: canonicalOrg.id as SpaceOrOrganizationId })
				.where(
					inArray(spaceVideos.spaceId, sourceOrgIds as SpaceOrOrganizationId[]),
				);

			await tx
				.update(s3Buckets)
				.set({ organizationId: canonicalOrg.id })
				.where(inArray(s3Buckets.organizationId, sourceOrgIds));

			await tx
				.update(storageIntegrations)
				.set({ organizationId: canonicalOrg.id })
				.where(inArray(storageIntegrations.organizationId, sourceOrgIds));

			await tx
				.delete(organizationMembers)
				.where(inArray(organizationMembers.organizationId, sourceOrgIds));

			await tx
				.update(organizations)
				.set({ tombstoneAt: new Date() })
				.where(inArray(organizations.id, sourceOrgIds));
		}
	});

	console.log(
		`✅ Domain ${domain}: canonical org ${canonicalOrg.id}, merged ${sourceOrgIds.length} org(s), grouped ${usersForDomain.length} user(s)`,
	);
}

export async function runDomainOrganizationBackfill() {
	console.log("🏢 Starting domain organization backfill...");

	const userRows = await db()
		.select({
			id: users.id,
			email: users.email,
			activeOrganizationId: users.activeOrganizationId,
			defaultOrganizationId: users.defaultOrgId,
			thirdPartyStripeSubscriptionId: users.thirdPartyStripeSubscriptionId,
			stripeSubscriptionId: users.stripeSubscriptionId,
			inviteQuota: users.inviteQuota,
		})
		.from(users);

	const usersByDomain = new Map<string, DomainUser[]>();
	for (const user of userRows) {
		const domain = normalizeDomain(user.email);
		if (!domain) {
			continue;
		}

		const current = usersByDomain.get(domain) ?? [];
		current.push(user);
		usersByDomain.set(domain, current);
	}

	const orderedDomains = [...usersByDomain.keys()].sort();
	for (const domain of orderedDomains) {
		const usersForDomain = usersByDomain.get(domain) ?? [];
		await mergeDomainOrganizations(domain, usersForDomain);
	}

	const remainingActiveOrganizations = await db()
		.select({ count: sql<number>`count(*)` })
		.from(organizations)
		.where(isNull(organizations.tombstoneAt));

	console.log(
		`🏁 Domain organization backfill complete. Active organizations: ${remainingActiveOrganizations[0]?.count ?? 0}`,
	);
}
