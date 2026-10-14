/**
 * Rendering a ticket transcript, and posting it to an archive channel when a
 * ticket closes.
 *
 * This lives apart from src/lib/transcript.js on purpose: that module is pure
 * and has no heavy dependencies, so its checks run without spawning anything.
 * This one pulls in the worker pools and the template engine.
 *
 * The rendering here was previously inline in the `/transcript` command. It
 * moved so that the close path can reuse it rather than carry a second copy
 * of the query, the decryption hand-off, the media resolution and the
 * template render.
 */

const fs = require('fs');
const { join } = require('path');
const Mustache = require('mustache');
const { AttachmentBuilder } = require('discord.js');
const ExtendedEmbedBuilder = require('../embed');
const storage = require('../storage');
const {
	resolveTicketMedia,
	resolveTranscriptChannel,
} = require('../transcript');
const { pools } = require('../threads');

const { transcript: pool } = pools;

// Transcripts are rendered from the template verbatim; they are not HTML.
Mustache.escape = text => text;

/**
 * Discord's upload ceiling is 10 MiB for an unboosted guild, and a transcript
 * is plain text, so anything approaching this is a very long ticket. Staying
 * under the limit rather than at it leaves room for the multipart envelope.
 */
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/** Everything a transcript needs, in one query. */
const TRANSCRIPT_INCLUDE = {
	archivedChannels: true,
	archivedMessages: {
		orderBy: { createdAt: 'asc' },
		where: { external: false },
	},
	archivedRoles: true,
	archivedUsers: true,
	category: true,
	claimedBy: true,
	closedBy: true,
	createdBy: true,
	feedback: true,
	guild: true,
	questionAnswers: { include: { question: true } },
};

let template;
let templateName;

/**
 * Read the configured transcript template, caching it per name so a config
 * reload picks up a different template without a restart.
 * @param {import("client")} client
 * @returns {string}
 */
function getTemplate(client) {
	const name = client.config.templates.transcript;
	if (template === undefined || templateName !== name) {
		template = fs.readFileSync(
			join('./user/templates/', name + '.mustache'),
			{ encoding: 'utf8' },
		);
		templateName = name;
	}
	return template;
}

/**
 * Fetch a ticket with everything a transcript needs.
 * @param {import("client")} client
 * @param {object} where a Prisma `where` for a unique ticket
 * @returns {Promise<object?>}
 */
async function fetchTicketForTranscript(client, where) {
	return await client.prisma.ticket.findUnique({
		include: TRANSCRIPT_INCLUDE,
		where,
	});
}

/**
 * Render a ticket to its transcript.
 *
 * @param {import("client")} client
 * @param {object} ticket a ticket fetched with TRANSCRIPT_INCLUDE
 * @returns {Promise<{fileName: string, transcript: string}>}
 */
async function renderTranscript(client, ticket) {
	// Decryption happens on a worker thread; media resolution has to happen
	// back here, because presigning needs the S3 client.
	ticket = await pool.queue(w => w(ticket));

	await resolveTicketMedia(ticket, {
		enabled: storage.enabled,
		log: client.log,
		presign: storage.presign,
	});

	const channelName = ticket.category.channelName
		.replace(/{+\s?(user)?name\s?}+/gi, ticket.createdBy?.username)
		.replace(/{+\s?(nick|display)(name)?\s?}+/gi, ticket.createdBy?.displayName)
		.replace(/{+\s?num(ber)?\s?}+/gi, ticket.number);

	const name = client.config.templates.transcript;
	const fileName = `${channelName}.${name.split('.').slice(-1)[0]}`;

	const transcript = Mustache.render(getTemplate(client), {
		channelName,
		closedAtFull: function () {
			return new Intl.DateTimeFormat([ticket.guild.locale, 'en-GB'], {
				dateStyle: 'full',
				timeStyle: 'long',
				timeZone: 'Etc/UTC',
			}).format(this.closedAt);
		},
		createdAtFull: function () {
			return new Intl.DateTimeFormat([ticket.guild.locale, 'en-GB'], {
				dateStyle: 'full',
				timeStyle: 'long',
				timeZone: 'Etc/UTC',
			}).format(this.createdAt);
		},
		createdAtTimestamp: function () {
			return new Intl.DateTimeFormat([ticket.guild.locale, 'en-GB'], {
				dateStyle: 'short',
				timeStyle: 'long',
				timeZone: 'Etc/UTC',
			}).format(this.createdAt);
		},
		guildName: client.guilds.cache.get(ticket.guildId)?.name,
		pinned: ticket.pinnedMessageIds.join(', '),
		ticket,
	});

	return {
		fileName,
		transcript,
	};
}

/**
 * Post a closed ticket's transcript to the configured archive channel.
 *
 * Does nothing unless `transcripts.onClose` names a channel in config.yml.
 * Called from the close path and never awaited there: a ticket must close
 * whatever happens here.
 *
 * The transcript is attached as a file rather than linked, because a link is
 * presigned and expires, which would leave an archive channel full of dead
 * URLs. A transcript too large to attach falls back to a link when object
 * storage is configured, and otherwise says how to fetch it.
 *
 * @param {import("client")} client
 * @param {object} closedTicket the ticket as `finallyClose` has it
 * @returns {Promise<void>}
 */
async function postClosedTranscript(client, closedTicket) {
	const channelId = resolveTranscriptChannel(
		client.config,
		closedTicket.guildId,
		client.log,
	);
	if (!channelId) return;

	const channel = client.channels.cache.get(channelId);
	if (!channel) {
		client.log.warn(
			'transcripts.onClose names channel %s, which this bot cannot see',
			channelId,
		);
		return;
	}

	// finallyClose's ticket does not carry the archive relations, so re-read
	// it. By this point the Discord channel is gone and the archive in the
	// database is the only copy, which is exactly what is being rendered.
	const ticket = await fetchTicketForTranscript(client, { id: closedTicket.id });
	if (!ticket) return;

	const getMessage = client.i18n.getLocale(ticket.guild.locale);
	const {
		fileName,
		transcript,
	} = await renderTranscript(client, ticket);

	const embed = new ExtendedEmbedBuilder({
		iconURL: client.guilds.cache.get(ticket.guildId)?.iconURL(),
		text: ticket.guild.footer,
	})
		.setColor(ticket.guild.primaryColour)
		.setTitle(getMessage('transcripts.archive.title'))
		.addFields(
			{
				inline: true,
				name: getMessage('dm.closed.fields.ticket'),
				value: `${ticket.category.name} **#${ticket.number}**`,
			},
			{
				inline: true,
				name: getMessage('dm.closed.fields.created'),
				value: `<t:${Math.floor(ticket.createdAt / 1000)}:f>`,
			},
			{
				inline: true,
				name: getMessage('dm.closed.fields.closed.name'),
				value: `<t:${Math.floor(ticket.closedAt / 1000)}:f>`,
			},
			{
				inline: true,
				name: getMessage('transcripts.archive.opened_by'),
				value: `<@${ticket.createdById}>`,
			},
		);

	if (ticket.closedById) {
		embed.addFields({
			inline: true,
			name: getMessage('dm.closed.fields.closed_by'),
			value: `<@${ticket.closedById}>`,
		});
	}

	const bytes = Buffer.byteLength(transcript, 'utf8');

	if (bytes <= MAX_ATTACHMENT_BYTES) {
		await channel.send({
			embeds: [embed],
			files: [
				new AttachmentBuilder()
					.setFile(Buffer.from(transcript))
					.setName(fileName),
			],
		});
		return;
	}

	client.log.info(
		'Transcript for ticket %s is %d bytes, too large to attach',
		ticket.id,
		bytes,
	);

	if (storage.enabled) {
		const key = storage.buildKey('transcripts', ticket.guildId, ticket.id, fileName);
		await storage.put({
			body: Buffer.from(transcript),
			contentType: 'text/plain; charset=utf-8',
			key,
		});
		const url = await storage.presign(key, { filename: fileName });
		embed.setDescription(getMessage('transcripts.archive.too_large_link', {
			fileName,
			url,
		}));
	} else {
		embed.setDescription(getMessage('transcripts.archive.too_large', { number: ticket.number }));
	}

	await channel.send({ embeds: [embed] });
}

module.exports = {
	MAX_ATTACHMENT_BYTES,
	TRANSCRIPT_INCLUDE,
	fetchTicketForTranscript,
	postClosedTranscript,
	renderTranscript,
};
