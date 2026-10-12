const { pools } = require('../threads');
const storage = require('../storage');
const avatars = require('../avatars');
const ms = require('ms');

const { crypto } = pools;

/**
 * Returns highest (roles.highest) hoisted role, or everyone
 * @param {import("discord.js").GuildMember} member
 * @returns {import("discord.js").Role}
 */
const hoistedRole = member => member.roles.hoist || member.guild.roles.everyone;

module.exports = class TicketArchiver {
	constructor(client) {
		/** @type {import("client")} */
		this.client = client;
	}

	/**
	 * Resolve the value to store in `ArchivedUser.avatar`.
	 *
	 * Discord avatar URLs do not expire the way attachment URLs do, but the
	 * hash stops resolving as soon as the member changes their avatar, so an
	 * archive that keeps only the hash loses the picture the ticket actually
	 * happened with. Mirroring the image preserves it.
	 *
	 * Returns a prefixed object key when the image was mirrored, and falls
	 * back to the bare hash — the previous behaviour — otherwise. Either form
	 * is readable with `avatars.decodeAvatar`.
	 *
	 * @param {import("discord.js").GuildMember} member
	 * @returns {Promise<string?>}
	 */
	async saveAvatar(member) {
		// `member.avatar` is the per-guild avatar and `member.user.avatar` the
		// global one. Keeping just the hash, as this did before, leaves no way
		// to tell which of the two it was, and the CDN paths differ -- so the
		// mirrored URL comes from displayAvatarURL(), which resolves that.
		const hash = member.avatar || member.user.avatar || null;

		// No hash means the member is on a default avatar. Those are a fixed
		// set of six images shared by every such user, so there is nothing
		// worth preserving.
		if (!hash || !storage.archiveAvatars) return hash;

		// Avatars are content-addressed: the same hash is the same image, so
		// one object serves every ticket and message that member appears in.
		// Without this cache the archiver would re-upload an avatar for every
		// message, since an ArchivedUser is upserted per message.
		const key = storage.buildKey('avatars', member.user.id, `${hash}.webp`);
		const cacheKey = `cache/avatar-mirrored:${key}`;

		try {
			if (await this.client.keyv.has(cacheKey)) return avatars.encodeAvatar(key);

			const written = await storage.mirror(
				member.displayAvatarURL({
					extension: 'webp',
					size: avatars.AVATAR_SIZE,
				}),
				key,
				{ contentType: 'image/webp' },
			);

			if (!written) return hash;

			await this.client.keyv.set(cacheKey, true, ms('7d'));
			return avatars.encodeAvatar(written);
		} catch (error) {
			// A missing avatar is a slightly poorer archive, not a failed one.
			this.client.log.warn('Failed to mirror avatar for user %s', member.user.id);
			this.client.log.error(error);
			return hash;
		}
	}

	/** Add or update a message
	 * @param {string} ticketId
	 * @param {import("discord.js").Message} message
	 * @param {boolean?} external
	 * @returns {import("@prisma/client").ArchivedMessage|boolean}
	 */
	async saveMessage(ticketId, message, external = false) {
		if (process.env.OVERRIDE_ARCHIVE === 'false') return false;

		if (!message.member) {
			try {
				message.member = await message.guild.members.fetch(message.author.id);
			} catch {
				this.client.log.verbose('Failed to fetch member %s of %s', message.author.id, message.guild.id);
			}
		}

		const channels = new Set(message.mentions.channels.values());
		const members = new Set(message.mentions.members.values());
		const roles = new Set(message.mentions.roles.values());

		try {
			const queries = [];

			members.add(message.member);

			for (const member of members) {
				roles.add(hoistedRole(member));
			}

			for (const role of roles) {
				const data = {
					colour: role.hexColor.slice(1),
					name: role.name,
				};
				queries.push(
					this.client.prisma.archivedRole.upsert({
						create: {
							...data,
							roleId: role.id,
							ticketId,
						},
						select: { ticketId: true },
						update: data,
						where: {
							ticketId_roleId: {
								roleId: role.id,
								ticketId,
							},
						},
					}),
				);
			}

			for (const member of members) {
				const data = {
					avatar: await this.saveAvatar(member),
					bot: member.user.bot,
					discriminator: member.user.discriminator,
					displayName: member.displayName ? await crypto.queue(w => w.encrypt(member.displayName)) : null,
					roleId: !!member && hoistedRole(member).id,
					username: await crypto.queue(w => w.encrypt(member.user.username)),
				};
				queries.push(
					this.client.prisma.archivedUser.upsert({
						create: {
							...data,
							ticketId,
							userId: member.user.id,
						},
						select: { ticketId: true },
						update: data,
						where: {
							ticketId_userId: {
								ticketId,
								userId: member.user.id,
							},
						},
					}),
				);
			}

			for (const channel of channels) {
				const data = {
					channelId: channel.id,
					name: channel.name,
					ticketId,
				};
				queries.push(
					this.client.prisma.archivedChannel.upsert({
						create: data,
						select: { ticketId: true },
						update: data,
						where: {
							ticketId_channelId: {
								channelId: channel.id,
								ticketId,
							},
						},
					}),
				);
			}

			// Discord's CDN URLs expire, so an archive that stores only the URL
			// silently rots: the transcript still lists the attachment but the
			// link is dead. Mirroring the bytes to S3 and recording the key
			// alongside the original URL makes the archive self-contained.
			//
			// `toJSON()` is what JSON.stringify would have called anyway, so
			// the stored shape is unchanged apart from the added `s3Key` —
			// which matters because the attachment list lives inside an
			// encrypted blob that older rows will not have.
			const attachments = [...message.attachments.values()].map(attachment => attachment.toJSON());

			if (storage.archiveAttachments && attachments.length > 0) {
				await Promise.all(attachments.map(async (attachment, i) => {
					try {
						const key = storage.buildKey(
							'attachments',
							ticketId,
							message.id,
							attachment.id,
							attachment.name,
						);
						// Returns null when the file is over the size cap or
						// the source has already gone; either way the original
						// URL is all we keep.
						const written = await storage.mirror(attachment.url, key, {
							contentType: attachment.contentType,
							size: attachment.size,
						});
						if (written) {
							attachments[i] = {
								...attachment,
								s3Key: written,
							};
						}
					} catch (error) {
						this.client.log.warn('Failed to mirror attachment %s of message %s', attachment.id, message.id);
						this.client.log.error(error);
					}
				}));
			}

			const data = {
				content: await crypto.queue(w => w.encrypt(
					JSON.stringify({
						attachments,
						components: [...message.components.values()],
						content: message.content,
						embeds: message.embeds.map(embed => ({ ...embed })),
						reference: message.reference?.messageId ?? null,
					}),
				)),
				createdAt: message.createdAt,
				edited: !!message.editedAt,
				external,
			};

			queries.push(
				this.client.prisma.archivedMessage.upsert({
					create: {
						...data,
						authorId: message.author?.id || 'default',
						id: message.id,
						ticketId,
					},
					select: { ticketId: true },
					update: data,
					where: { id: message.id },
				}),
			);

			return await this.client.prisma.$transaction(queries);
		} catch (error) {
			this.client.log.error('Failed to archive message %s', message.id);
			this.client.log.error(error);
			return false;
		}
	}
};
