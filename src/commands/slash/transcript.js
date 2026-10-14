const { SlashCommand } = require('@eartharoid/dbf');
const {
	ApplicationCommandOptionType,
	PermissionsBitField,
	MessageFlags,
} = require('discord.js');
const { AttachmentBuilder } = require('discord.js');
const ExtendedEmbedBuilder = require('../../lib/embed');
const storage = require('../../lib/storage');
const {
	TRANSCRIPT_INCLUDE,
	renderTranscript,
} = require('../../lib/tickets/transcript');
const ms = require('ms');

module.exports = class TranscriptSlashCommand extends SlashCommand {
	constructor(client, options) {
		const name = 'transcript';
		super(client, {
			...options,
			description: client.i18n.getMessage(null, `commands.slash.${name}.description`),
			descriptionLocalizations: client.i18n.getAllMessages(`commands.slash.${name}.description`),
			dmPermission: false,
			name,
			nameLocalizations: client.i18n.getAllMessages(`commands.slash.${name}.name`),
			options: [
				{
					autocomplete: true,
					name: 'ticket',
					required: true,
					type: ApplicationCommandOptionType.String,
				},
				{
					name: 'member',
					required: false,
					type: ApplicationCommandOptionType.User,
				},
			].map(option => {
				option.descriptionLocalizations = client.i18n.getAllMessages(`commands.slash.${name}.options.${option.name}.description`);
				option.description = option.descriptionLocalizations['en-GB'];
				option.nameLocalizations = client.i18n.getAllMessages(`commands.slash.${name}.options.${option.name}.name`);
				return option;
			}),
		});
	}

	shouldAllowAccess(interaction, ticket) {
		// the creator can always get their ticket, even from outside the guild
		if (ticket.createdById === interaction.user.id) return true; // user not member (DMs)
		// everyone else must be in the guild
		if (interaction.guild?.id !== ticket.guildId) return false;
		// and have authority
		if (interaction.client.supers.includes(interaction.member.id)) return true;
		if (interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return true;
		if (interaction.member.roles.cache.filter(role => ticket.category.staffRoles.includes(role.id)).size > 0) return true;
		return false;
	}

	async fillTemplate(ticket) {
		return await renderTranscript(this.client, ticket);
	}

	/**
	 * @param {import("discord.js").ChatInputCommandInteraction} interaction
	 */
	async run(interaction, ticketId) {
		/** @type {import("client")} */
		const client = this.client;

		await interaction.deferReply({ flags: MessageFlags.Ephemeral });
		ticketId = ticketId || interaction.options.getString('ticket', true);
		const ticket = await client.prisma.ticket.findUnique({
			include: TRANSCRIPT_INCLUDE,
			where: interaction.guildId && ticketId.length < 16
				? {
					guildId_number: {
						guildId: interaction.guildId,
						number: parseInt(ticketId),
					},
				}
				: { id: ticketId },
		});

		if (!ticket) throw new Error(`Ticket ${ticketId} does not exist`);

		if (!this.shouldAllowAccess(interaction, ticket)) {
			const settings = await client.prisma.guild.findUnique({ where: { id: interaction.guild.id } });
			const getMessage = client.i18n.getLocale(settings.locale);
			return await interaction.editReply({
				embeds: [
					new ExtendedEmbedBuilder({
						iconURL: interaction.guild.iconURL(),
						text: ticket.guild.footer,
					})
						.setColor(ticket.guild.errorColour)
						.setTitle(getMessage('commands.slash.transcript.not_staff.title'))
						.setDescription(getMessage('commands.slash.transcript.not_staff.description')),
				],
			});
		}

		const {
			fileName,
			transcript,
		} = await this.fillTemplate(ticket);

		// Prefer a presigned S3 link when object storage is configured: a busy
		// ticket can render past Discord's upload limit, at which point
		// attaching the file fails outright. Any failure here falls through to
		// the attachment, because a transcript delivered the old way beats no
		// transcript at all.
		if (storage.enabled) {
			try {
				const key = storage.buildKey('transcripts', ticket.guildId, ticket.id, fileName);
				await storage.put({
					body: Buffer.from(transcript),
					contentType: 'text/plain; charset=utf-8',
					key,
				});
				const url = await storage.presign(key, { filename: fileName });
				const getMessage = client.i18n.getLocale(ticket.guild.locale);
				return await interaction.editReply({
					embeds: [
						new ExtendedEmbedBuilder({
							iconURL: interaction.guild?.iconURL(),
							text: ticket.guild.footer,
						})
							.setColor(ticket.guild.primaryColour)
							.setTitle(getMessage('commands.slash.transcript.link.title'))
							.setDescription(getMessage('commands.slash.transcript.link.description', {
								expiry: ms(storage.urlExpiry * 1000, { long: true }),
								fileName,
								url,
							})),
					],
				});
			} catch (error) {
				client.log.warn('Failed to upload transcript for ticket %s, falling back to attachment', ticket.id);
				client.log.error(error);
			}
		}

		const attachment = new AttachmentBuilder()
			.setFile(Buffer.from(transcript))
			.setName(fileName);

		await interaction.editReply({ files: [attachment] });
		// TODO: add portal link
	}
};
