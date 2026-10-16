const { PermissionsBitField } = require('discord.js');

/**
 *
 * @param {import("discord.js").Client} client
 * @param {string} userId
 * @returns {Promise<Collection<import("discord.js").Guild>}
 */
module.exports.getCommonGuilds = (client, userId) => client.guilds.cache.filter(guild => guild.members.cache.has(userId));

/**
 * @param {import("discord.js").Guild} guild
 * @returns {Promise<string[]>}
 */
const updateStaffRoles = async guild => {
	const { categories } = await guild.client.prisma.guild.findUnique({
		select: { categories: { select: { staffRoles: true } } },
		where: { id: guild.id },
	});
	const staffRoles = [
		...new Set(
			categories.reduce((acc, c) => {
				acc.push(...c.staffRoles);
				return acc;
			}, []),
		),
	];
	await guild.client.keyv.set(`cache/guild-staff:${guild.id}`, staffRoles);
	return staffRoles;
};

module.exports.updateStaffRoles = updateStaffRoles;

/**
 *
 * @param {import("discord.js").Guild} guild
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
module.exports.isStaff = async (guild, userId) => {
	/** @type {import("client")} */
	const client = guild.client;
	if (client.supers.includes(userId)) return true;
	try {
		const guildMember = guild.members.cache.get(userId) || await guild.members.fetch(userId);
		if (guildMember.permissions.has(PermissionsBitField.Flags.ManageGuild)) return true;
		const staffRoles = await client.keyv.get(`cache/guild-staff:${guild.id}`) || await updateStaffRoles(guild);
		return staffRoles.some(r => guildMember.roles.cache.has(r));
	} catch {
		return false;
	}
};

/**
 * A role whose *name* is exactly this (case-insensitively, trimmed) grants bot
 * administration through the dashboard, alongside the `ManageGuild`
 * permission.
 *
 * Matching on a name rather than a permission is a deliberate choice, and it
 * is worth knowing what it costs: role names are not access-controlled the way
 * permissions are, so anyone able to create or rename roles -- `ManageRoles`,
 * which is weaker than `ManageGuild` -- can grant themselves bot
 * administration by naming a role "admin". The match is exact rather than a
 * substring so that "Administrator", "admin-helper" and "non-admin" do not
 * qualify by accident.
 */
const ADMIN_ROLE_NAME = 'admin';

module.exports.ADMIN_ROLE_NAME = ADMIN_ROLE_NAME;

/**
 * @param {import("discord.js").GuildMember} member
 * @returns {boolean}
 */
const hasAdminRole = member =>
	member.roles.cache.some(role => role.name.trim().toLowerCase() === ADMIN_ROLE_NAME);

module.exports.hasAdminRole = hasAdminRole;

/**
 *
 * @param {import("discord.js")} member
 * @returns {Promise<number>}
 * 	- `4` = OPERATOR (SUPER)
 *  - `3` = GUILD_OWNER
 *  - `2` = GUILD_ADMIN (`ManageGuild`, or a role named "admin")
 *  - `1` = GUILD_STAFF
 *  - `0` = GUILD_MEMBER
 *  - `-1` = NONE (NOT A MEMBER)
 */
module.exports.getPrivilegeLevel = async member => {
	if (!member) return -1;
	else if (member.guild.client.supers.includes(member.id)) return 4;
	else if (member.guild.ownerId === member.id) return 3;
	else if (member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return 2;
	else if (hasAdminRole(member)) return 2;
	else if (await this.isStaff(member.guild, member.id)) return 1;
	else return 0;
};
