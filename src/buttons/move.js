const { Button } = require('@eartharoid/dbf');
const {
	ActionRowBuilder,
	MessageFlags,
	StringSelectMenuBuilder,
	StringSelectMenuOptionBuilder,
} = require('discord.js');
const emoji = require('node-emoji');
const ExtendedEmbedBuilder = require('../lib/embed');
const { isStaff } = require('../lib/users');

module.exports = class MoveButton extends Button {
	constructor(client, options) {
		super(client, {
			...options,
			id: 'move',
		});
	}

	/**
	 * @param {*} id
	 * @param {import("discord.js").ButtonInteraction} interaction
	 */
	async run(id, interaction) {
		/** @type {import("client")} */
		const client = this.client;

		const ticket = await client.prisma.ticket.findUnique({
			select: {
				categoryId: true,
				guild: {
					select: {
						errorColour: true,
						footer: true,
						locale: true,
						primaryColour: true,
					},
				},
			},
			where: { id: interaction.channel.id },
		});

		if (!ticket) {
			const settings = await client.prisma.guild.findUnique({ where: { id: interaction.guild.id } });
			const getMessage = client.i18n.getLocale(settings.locale);
			return await interaction.reply({
				embeds: [
					new ExtendedEmbedBuilder({
						iconURL: interaction.guild.iconURL(),
						text: settings.footer,
					})
						.setColor(settings.errorColour)
						.setTitle(getMessage('misc.not_ticket.title'))
						.setDescription(getMessage('misc.not_ticket.description')),
				],
				flags: MessageFlags.Ephemeral,
			});
		}

		const getMessage = client.i18n.getLocale(ticket.guild.locale);

		if (!(await isStaff(interaction.guild, interaction.user.id))) {
			return await interaction.reply({
				embeds: [
					new ExtendedEmbedBuilder({
						iconURL: interaction.guild.iconURL(),
						text: ticket.guild.footer,
					})
						.setColor(ticket.guild.errorColour)
						.setTitle(getMessage('commands.slash.move.not_staff.title'))
						.setDescription(getMessage('commands.slash.move.not_staff.description')),
				],
				flags: MessageFlags.Ephemeral,
			});
		}

		const categories = (await client.prisma.category.findMany({ where: { guildId: interaction.guild.id } }))
			.filter(category => category.id !== ticket.categoryId);

		if (categories.length === 0) {
			return await interaction.reply({
				embeds: [
					new ExtendedEmbedBuilder({
						iconURL: interaction.guild.iconURL(),
						text: ticket.guild.footer,
					})
						.setColor(ticket.guild.errorColour)
						.setTitle(getMessage('misc.no_other_categories.title'))
						.setDescription(getMessage('misc.no_other_categories.description')),
				],
				flags: MessageFlags.Ephemeral,
			});
		}

		await interaction.reply({
			components: [
				new ActionRowBuilder()
					.setComponents(
						new StringSelectMenuBuilder()
							.setCustomId(JSON.stringify({ action: 'move' }))
							.setPlaceholder(getMessage('menus.move.placeholder'))
							.setOptions(
								// Discord allows a maximum of 25 options
								categories.slice(0, 25).map(category => {
									const option = new StringSelectMenuOptionBuilder()
										.setValue(String(category.id))
										.setLabel(category.name);
									if (category.description) option.setDescription(category.description.slice(0, 100));
									if (category.emoji) {
										option.setEmoji(emoji.hasEmoji(category.emoji)
											? emoji.get(category.emoji)
											: { id: category.emoji });
									}
									return option;
								}),
							),
					),
			],
			embeds: [
				new ExtendedEmbedBuilder({
					iconURL: interaction.guild.iconURL(),
					text: ticket.guild.footer,
				})
					.setColor(ticket.guild.primaryColour)
					.setTitle(getMessage('ticket.move.title'))
					.setDescription(getMessage('ticket.move.description')),
			],
			flags: MessageFlags.Ephemeral,
		});
	}
};
