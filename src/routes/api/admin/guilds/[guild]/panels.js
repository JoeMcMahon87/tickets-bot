const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle: {
		Primary,
		Secondary,
	},
	ChannelType: { GuildText },
	EmbedBuilder,
	StringSelectMenuBuilder,
	StringSelectMenuOptionBuilder,
} = require('discord.js');
const emoji = require('node-emoji');
const { logAdminEvent } = require('../../../../../lib/logging');
const {
	describe, missingChannelPermissions,
} = require('../../../../../lib/panel-errors');
const panelSchema = require('../../../../../schemas/panel.js');

module.exports.post = fastify => ({
	handler: async (req, res) => {
		/** @type {import('client')} */
		const client = req.routeOptions.config.client;
		const guild = client.guilds.cache.get(req.params.guild);
		const data = req.body;

		// Creating a panel is a sequence of Discord calls, and a rejection from
		// any of them used to reach the log as a bare DiscordAPIError with a
		// line number and nothing about what was being attempted. Each step is
		// named, so the log says which one failed and why.
		const step = async (name, fn, context = {}) => {
			client.log.verbose.http(`${req.id} panel: ${name}`);
			try {
				return await fn();
			} catch (error) {
				client.log.error.http(`${req.id} panel: ` + describe({
					error,
					step: name,
					...context,
				}));
				error.panelStep = name;
				throw error;
			}
		};

		const settings = await client.prisma.guild.findUnique({
			select: {
				categories: true,
				footer: true,
				locale: true,
				primaryColour: true,
			},
			where: { id: guild.id },
		});
		const getMessage = client.i18n.getLocale(settings.locale);

		/** Rejected before any Discord call, so nothing is half-created. */
		const reject = message => {
			client.log.warn.http(`${req.id} panel: refused | ${message}`);
			return res.code(400).send({
				error: 'Bad Request',
				message,
				statusCode: 400,
			});
		};

		const categories = [];
		for (const id of data.categories) {
			const category = settings.categories.find(c => c.id === id);
			if (!category) {
				return reject(`Category ${id} does not exist in this server. It may have been deleted since the page was loaded; reload and try again.`);
			}
			categories.push(category);
		}

		if (categories.length === 0) {
			return reject('A panel needs at least one category.');
		}
		if (categories.length !== 1 && data.type === 'MESSAGE') {
			return reject(`A MESSAGE panel can only offer one category, but ${categories.length} were selected. Use a BUTTON or MENU panel for several.`);
		}

		/** @type {import("discord.js").TextChannel} */
		let channel;
		if (data.channel) {
			channel = await step(
				'fetch the channel the panel should go in',
				() => client.channels.fetch(data.channel),
				{ channelId: data.channel },
			);
		} else {
			const allow = ['ViewChannel', 'ReadMessageHistory'];
			if (data.type === 'MESSAGE') allow.push('SendMessages');
			channel = await step('create a channel for the panel', () => guild.channels.create({
				name: 'create-a-ticket',
				permissionOverwrites: [
					{
						allow,
						deny: ['AddReactions', 'AttachFiles'],
						id: guild.roles.everyone,
					},
				],
				position: 1,
				rateLimitPerUser: 15,
				reason: 'New ticket panel',
				type: GuildText,
			}));
		}

		// Checked before sending rather than after failing, because Discord
		// answers a missing permission with an opaque 50013 that names neither
		// the permission nor the channel. EmbedLinks is the usual culprit: a
		// panel is an embed, so the send fails even though the bot can plainly
		// talk in the channel.
		const missing = missingChannelPermissions(channel.permissionsFor(guild.members.me));
		if (missing.length > 0) {
			client.log.warn.http(`${req.id} panel: refused | channel=${channel.id} | missing=${missing.join(', ')}`);
			if (!data.channel) await channel.delete('Panel could not be posted').catch(() => null);
			return res.code(403).send({
				error: 'Forbidden',
				message: `The bot cannot post a panel in #${channel.name}: it is missing ${missing.join(', ')}. Grant those in that channel's permissions and try again.`,
				statusCode: 403,
			});
		}

		const embed = new EmbedBuilder()
			.setColor(settings.primaryColour);

		if (settings.footer) {
			embed.setFooter({
				iconURL: guild.iconURL(),
				text: settings.footer,
			});
		}

		if (data.title) embed.setTitle(data.title);
		if (data.description) embed.setDescription(data.description);
		if (data.image) embed.setImage(data.image);
		if (data.thumbnail) embed.setThumbnail(data.thumbnail);

		if (data.type === 'MESSAGE') {
			await step(
				'send the panel message',
				() => channel.send({ embeds: [embed] }),
				{ channelId: channel.id },
			);
		} else {
			const components = [];

			if (categories.length === 1) {
				components.push(
					new ButtonBuilder()
						.setCustomId(JSON.stringify({
							action: 'create',
							target: categories[0].id,
						}))
						.setStyle(Primary)
						.setLabel(getMessage('buttons.create.text'))
						.setEmoji(getMessage('buttons.create.emoji')),
				);
			} else if (data.type === 'BUTTON') {
				components.push(
					...categories.map(category =>
						new ButtonBuilder()
							.setCustomId(JSON.stringify({
								action: 'create',
								target: category.id,
							}))
							.setStyle(Secondary)
							.setLabel(category.name)
							.setEmoji(emoji.hasEmoji(category.emoji) ? emoji.get(category.emoji) : { id: category.emoji }),
					),
				);
			} else {
				components.push(
					new StringSelectMenuBuilder()
						.setCustomId(JSON.stringify({ action: 'create' }))
						.setPlaceholder(getMessage('menus.category.placeholder'))
						.setOptions(
							categories.map(category =>
								new StringSelectMenuOptionBuilder()
									.setValue(String(category.id))
									.setLabel(category.name)
									.setDescription(category.description)
									.setEmoji(emoji.hasEmoji(category.emoji) ? emoji.get(category.emoji) : { id: category.emoji }),
							),
						),
				);

			}

			try {
				client.log.verbose.http(`${req.id} panel: send the panel message with components`);
				await channel.send({
					components: [
						new ActionRowBuilder()
							.setComponents(components),
					],
					embeds: [embed],
				});
			} catch (error) {
				// Logged before the handling below, so the cause is recorded
				// whichever branch is taken -- including the emoji case, which
				// answers 400 and would otherwise leave nothing in the log.
				client.log.error.http(`${req.id} panel: ` + describe({
					channelId: channel.id,
					error,
					missing: missingChannelPermissions(channel.permissionsFor(guild.members.me)),
					step: 'send the panel message with components',
				}));

				if (!data.channel) await channel.delete('Failed to send panel');

				const human_errors = [];
				const action_row = error?.rawError?.errors?.components?.['0'];
				const buttons_or_options = {
					BUTTON: action_row?.components,
					MENU: action_row?.components?.['0']?.options,
				}[data.type];

				if (buttons_or_options) {
					for (const [k, v] of Object.entries(buttons_or_options)) {
						// const category = categories.find(category => category.id === parseInt(k));
						const category = categories[parseInt(k)]; // k is a string of the index, not ID
						// eslint-disable-next-line no-underscore-dangle
						const emoji_errors = v?.emoji?.id?._errors;
						if (emoji_errors) {
							const invalid_name = emoji_errors[0]?.message?.match(/Value "(.*)" is not snowflake/)?.[1];
							if (invalid_name) {
								const url = `${process.env.HTTP_EXTERNAL}/settings/${guild.id}/categories/${category.id}`;
								human_errors.push({
									message: `The emoji for the \`${category.name}\` category is invalid: \`${invalid_name}\`. <a href="${url}" target="_blank">Click here</a> to open the category's settings page in a new tab.`,
									type: 'invalid_emoji',
								});
							}
						}
					}
				}

				if (human_errors.length) {
					return res.code(400).send({
						code: error.code,
						errors: human_errors,
						status: error.status,
					});
				}

				// A permission or access refusal is the common case and the
				// dashboard can act on it, so answer with the cause rather
				// than letting it surface as an unexplained 500.
				if (error.code === 50001 || error.code === 50013) {
					const lacking = missingChannelPermissions(channel.permissionsFor(guild.members.me));
					return res.code(403).send({
						error: 'Forbidden',
						message: lacking.length
							? `The bot cannot post a panel in #${channel.name}: it is missing ${lacking.join(', ')}. Grant those in that channel's permissions and try again.`
							: `Discord refused to post the panel in #${channel.name} (${error.code}: ${error.message}). The bot holds the channel permissions it needs, so this is likely an emoji it cannot use, or a category-level override.`,
						statusCode: 403,
					});
				}

				// Anything else is unexpected: rethrow so the onError hook
				// records the stack, which the line above does not carry.
				throw error;
			}
		}

		logAdminEvent(client, {
			action: 'create',
			guildId: guild.id,
			target: {
				id: channel.toString(),
				type: 'panel',
			},
			userId: req.user.id,
		});

		return true;
	},
	onRequest: [fastify.authenticate, fastify.isAdmin],
	schema: { body: panelSchema },
});
