const { Menu } = require('@eartharoid/dbf');

module.exports = class MoveMenu extends Menu {
	constructor(client, options) {
		super(client, {
			...options,
			id: 'move',
		});
	}

	/**
	 * @param {*} id
	 * @param {import("discord.js").StringSelectMenuInteraction} interaction
	 */
	async run(id, interaction) {
		// the menu lives in an ephemeral message, which `move` replaces with its response
		await interaction.deferUpdate();
		await this.client.tickets.move(interaction, Number(interaction.values[0]));
	}
};
