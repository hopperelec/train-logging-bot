import {
    Client,
    GatewayIntentBits,
    CommandInteraction,
    TextChannel,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ButtonInteraction,
    Message, User, Guild, AttachmentPayload, Snowflake,
} from 'discord.js';
import { config } from 'dotenv';

config();
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const APPROVAL_CHANNEL_ID = process.env.APPROVAL_CHANNEL_ID;
const CONTRIBUTOR_GUILD_ID = process.env.CONTRIBUTOR_GUILD_ID;
const CONTRIBUTOR_ROLE_ID = process.env.CONTRIBUTOR_ROLE_ID;
if (!DISCORD_TOKEN) {
    console.error('Missing DISCORD_TOKEN environment variable.');
    process.exit(1);
}
if (!LOG_CHANNEL_ID) {
    console.error('Missing LOG_CHANNEL_ID environment variable.');
    process.exit(1);
}
if (!APPROVAL_CHANNEL_ID) {
    console.warn('Missing APPROVAL_CHANNEL_ID environment variable. Non-contributors will not be able to submit entries for approval.');
}
if (!CONTRIBUTOR_GUILD_ID !== !CONTRIBUTOR_ROLE_ID) {
    console.error('Both CONTRIBUTOR_GUILD_ID and CONTRIBUTOR_ROLE_ID must be set if one is set.');
    process.exit(1);
}
if (!CONTRIBUTOR_GUILD_ID) {
    console.warn('Missing CONTRIBUTOR_GUILD_ID and CONTRIBUTOR_ROLE_ID environment variables. Anyone will be able to log entries.');
}

const MAX_SEARCH_RESULTS = 10; // Maximum number of search results to return

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages
    ]
});

type TRN = string;
type GenEntry = {
    description: string;
    source: string;
}
type Submission = GenEntry & {
    user: User;
    trn: TRN;
    previous?: GenEntry; // previous entry (for undoing)
}

let logChannel: TextChannel;
let approvalChannel: TextChannel;
let contributorGuild: Guild;
let logTrainCommandId: string;
let currentLogMessage: Message;
const todaysTrains = new Map<TRN, GenEntry>();
const unconfirmedEntries = new Map<string, GenEntry & {
    user: User;
    trn: TRN;
}>;
const publicSubmissions = new Map<Snowflake, Submission>();

function normalizeTRN(trn: TRN): TRN {
    return /^\d{3}$/.test(trn) ? `T${trn}` : trn;
}

function categorizeTRN(trn: TRN) {
    const match = trn.match(/T?(\d{3})/);
    if (!match) return 'other';
    const number = +match[1];
    if (number >= 101 && number <= 112) return 'green';
    if (number >= 121 && number <= 136) return 'yellow';
    return 'other';
}

function renderEntry(entry: { trn: TRN } & GenEntry) {
    return `${entry.trn} - ${entry.description}\n-# ${entry.source}`;
}

function generateDailyLogContent(): string | { content: string; files: [AttachmentPayload] } {
    if (todaysTrains.size === 0) return '*No trains have been logged yet today. Check back here later!*';

    const categories: Record<string, ({ trn: TRN } & GenEntry)[]> = {};
    for (const [trn, entry] of todaysTrains.entries()) {
        const line = categorizeTRN(trn);
        if (!categories[line]) categories[line] = [];
        categories[line].push({ trn, ...entry });
    }

    let content = '### Green line\n';
    if (categories.green) {
        content += categories.green.sort((a, b) => a.trn.localeCompare(b.trn)).map(renderEntry).join('\n');
    } else {
        content += '*No trains have been logged on the green line yet.*';
    }
    content += '\n### Yellow line\n';
    if (categories.yellow) {
        content += categories.yellow.sort((a, b) => a.trn.localeCompare(b.trn)).map(renderEntry).join('\n');
    } else {
        content += '*No trains have been logged on the yellow line yet.*';
    }
    if (categories.other) {
        content += '\n### Other workings\n';
        content += categories.other.sort((a, b) => a.trn.localeCompare(b.trn)).map(renderEntry).join('\n');
    }
    if (content.length <= 2000) return content;
    return {
        content: "Today's log is too long to display as a message, so it has been attached as a file.",
        files: [{
            name: `log-${new Date().toISOString().split('T')[0]}.txt`,
            attachment: Buffer.from(content, 'utf-8')
        }]
    }
}

async function updateLogMessage() {
    await currentLogMessage.edit(generateDailyLogContent()).catch(async () => {
        // If the message was deleted or something went wrong, create a new one
        currentLogMessage = await logChannel.send(generateDailyLogContent());
    });
}

async function addEntryToLog(trn: TRN, entry: GenEntry) {
    todaysTrains.set(trn, entry);
    await updateLogMessage();
}

async function removeEntryFromLog(trn: TRN) {
    if (todaysTrains.delete(trn)) {
        await updateLogMessage();
    }
}

async function submitNewEntry(user: User, trn: TRN, entry: GenEntry) {
    if (isContributor(user)) {
        await addEntryToLog(trn, entry);
        console.log(`Train "${trn}" logged by contributor @${user.tag}: ${entry.description} (Source: ${entry.source})`);
        return `✅ Train "${trn}" has been successfully added to the log!`;
    }
    if (!approvalChannel) return '❌ Only contributors can log trains right now.';

    const message = await approvalChannel.send({
        embeds: [
            new EmbedBuilder()
                .setTitle('Train gen submission')
                .setColor(0xff9900)
                .addFields(
                    { name: 'TRN', value: trn, inline: true },
                    { name: 'Description', value: entry.description, inline: true },
                    { name: 'Source', value: entry.source, inline: true },
                    { name: 'Submitted by', value: `<@${user.id}>` },
                )
        ],
        components: [
            new ActionRowBuilder<ButtonBuilder>()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('approve')
                        .setLabel('Approve')
                        .setStyle(ButtonStyle.Success)
                        .setEmoji('✅'),
                    new ButtonBuilder()
                        .setCustomId('deny')
                        .setLabel('Deny')
                        .setStyle(ButtonStyle.Danger)
                        .setEmoji('❌')
                )
        ]
    });
    publicSubmissions.set(message.id, { user, trn, ...entry, previous: todaysTrains.get(trn) });

    console.log(`New submission (${message.id}) by @${user.tag}: ${JSON.stringify({ trn, ...entry})}`);
    return '📋 Your gen has been submitted for approval by contributors.';
}

async function submitEntryUpdate(user: User, trn: TRN, newEntry: GenEntry) {
    if (isContributor(user)) {
        await addEntryToLog(trn, newEntry);
        console.log(`Train "${trn}" updated by contributor @${user.tag}: ${newEntry.description} (Source: ${newEntry.source})`);
        return `✅ Train "${trn}" has been successfully updated in the log!`;
    }
    if (!approvalChannel) return '❌ Only contributors can update trains right now.';

    const currentEntry = todaysTrains.get(trn);
    const message = await approvalChannel.send({
        embeds: [
            new EmbedBuilder()
                .setTitle('Train gen update submission')
                .setColor(0xff9900)
                .addFields(
                    { name: 'TRN', value: trn },
                    { name: 'Current description', value: currentEntry.description, inline: true },
                    { name: 'Current source', value: currentEntry.source, inline: true },
                    { name: '\u200b', value: '\u200b', inline: true }, // Empty field to force current and new entries to be on separate lines
                    { name: 'New description', value: newEntry.description, inline: true },
                    { name: 'New source', value: newEntry.source, inline: true },
                    { name: '\u200b', value: '\u200b', inline: true }, // Empty field to align "New source" with "Current source"
                    { name: 'Submitted by', value: `<@${user.id}>` }
                )
        ],
        components: [
            new ActionRowBuilder<ButtonBuilder>()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('approve')
                        .setLabel('Approve')
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('✏️'),
                    new ButtonBuilder()
                        .setCustomId('deny')
                        .setLabel('Deny')
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji('❌')
                )
        ]
    });
    publicSubmissions.set(message.id, { user, trn, ...newEntry });

    console.log(`Update submission (${message.id}) by @${user.tag}: ${JSON.stringify({ trn, ...newEntry })}`);
    return '📋 Your gen has been submitted for approval by contributors.';
}

async function approveSubmission(interaction: ButtonInteraction, submission: Submission) {
    submission.previous = todaysTrains.get(submission.trn);
    await addEntryToLog(submission.trn, { description: submission.description, source: submission.source || `<@${submission.user.id}>` });
    console.log(`Submission ${interaction.message.id} approved by @${interaction.user.tag}`);
    return {
        embeds: [
            new EmbedBuilder()
                .setTitle('Train entry approved')
                .setColor(0x00ff00)
                .setDescription(`Approved by <@${interaction.user.id}>`)
                .addFields(
                    { name: 'TRN', value: submission.trn, inline: true },
                    { name: 'Description', value: submission.description, inline: true },
                    { name: 'Source', value: submission.source, inline: true },
                    { name: 'Submitted by', value: `<@${submission.user.id}>` }
                )
        ],
        components: [
            new ActionRowBuilder<ButtonBuilder>()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`approve`)
                        .setLabel('Approved')
                        .setStyle(ButtonStyle.Success)
                        .setDisabled(true)
                        .setEmoji('✅'),
                    new ButtonBuilder()
                        .setCustomId(`undo`)
                        .setLabel('Undo')
                        .setStyle(ButtonStyle.Danger)
                        .setEmoji('↩️')
                )
        ]
    }
}

async function denySubmission(interaction: ButtonInteraction, submission: Submission) {
    console.log(`Submission ${interaction.message.id} denied by @${interaction.user.tag}`);
    return {
        embeds: [
            new EmbedBuilder()
                .setTitle('Train entry denied')
                .setColor(0xff0000)
                .setDescription(`Denied by <@${interaction.user.id}>`)
                .addFields(
                    { name: 'TRN', value: submission.trn, inline: true },
                    { name: 'Description', value: submission.description, inline: true },
                    { name: 'Source', value: submission.source, inline: true },
                    { name: 'Submitted by', value: `<@${submission.user.id}>` }
                )
        ],
        components: [
            new ActionRowBuilder<ButtonBuilder>()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('approve')
                        .setLabel('Approve')
                        .setStyle(ButtonStyle.Success)
                        .setEmoji('✅'),
                    new ButtonBuilder()
                        .setCustomId(`deny`)
                        .setLabel('Denied')
                        .setStyle(ButtonStyle.Danger)
                        .setDisabled(true)
                        .setEmoji('❌')
                )
        ]
    }
}

async function undoApprovedSubmission(interaction: ButtonInteraction, submission: Submission) {
    if (submission.previous) {
        await addEntryToLog(submission.trn, submission.previous);
    } else {
        await removeEntryFromLog(submission.trn);
    }
    return await denySubmission(interaction, submission);
}

function isContributor(user: User) {
    return !contributorGuild || contributorGuild.members.cache.get(user.id).roles.cache.some(role => role.id === CONTRIBUTOR_ROLE_ID);
}

async function handleCommandInteraction(interaction: CommandInteraction) {
    if (interaction.commandName === 'log-train') {
        const trn = normalizeTRN(interaction.options.get('trn', true).value as string);
        const entry = {
            description: interaction.options.get('description', true).value as string,
            source: (interaction.options.get('source')?.value || `<@${interaction.user.id}>`) as string
        };
        const existingEntry = todaysTrains.get(trn);
        if (existingEntry) {
            if (existingEntry.description === entry.description && existingEntry.source === entry.source) {
                await interaction.reply({
                    content: `❌ This entry is already in the log`,
                    flags: ["Ephemeral"]
                });
            } else {
                const differenceString = existingEntry.description !== entry.description
                    ? (existingEntry.source !== entry.source ? "description and source" : "description")
                    : "source";
                const uuid = crypto.randomUUID();
                unconfirmedEntries.set(uuid, { ...entry, user: interaction.user, trn });
                await interaction.reply({
                    content: `⚠️ An entry is already logged for this TRN, with a different ${differenceString}. Do you want to update it?`,
                    embeds: [
                        new EmbedBuilder()
                            .setTitle(`Existing entry for ${trn}`)
                            .addFields(
                                { name: 'Description', value: existingEntry.description, inline: true },
                                { name: 'Source', value: existingEntry.source, inline: true }
                            )
                    ],
                    components: [
                        new ActionRowBuilder<ButtonBuilder>()
                            .addComponents(
                                new ButtonBuilder()
                                    .setCustomId(`confirm-update:${uuid}`)
                                    .setLabel('Update')
                                    .setStyle(ButtonStyle.Primary)
                                    .setEmoji('✏️')
                            )
                    ],
                    flags: ["Ephemeral"],
                });
            }

        } else {
            const deferReplyPromise = interaction.deferReply({ flags: ["Ephemeral"] }).catch(console.error);
            const result = await submitNewEntry(interaction.user, trn, entry);
            await deferReplyPromise;
            interaction.editReply(result).catch(console.error);
        }

    } else if (interaction.commandName === 'remove-train') {
        if (!isContributor(interaction.user)) {
            await interaction.reply({
                content: '❌ Only contributors can remove trains from the log.',
                flags: ["Ephemeral"]
            });
            return;
        }

        const trn = normalizeTRN(interaction.options.get('trn', true).value as string);
        if (todaysTrains.has(trn)) {
            const deferReplyPromise = interaction.deferReply({ flags: ["Ephemeral"] }).catch(console.error);
            await removeEntryFromLog(trn);
            console.log(`Train "${trn}" removed from today's log by @${interaction.user.tag}`);
            await deferReplyPromise;
            interaction.editReply(`✅ Train "${trn}" has been successfully removed from today's log.`).catch(console.error);
        } else {
            interaction.reply(`❌ Train "${trn}" is not currently logged for today.`).catch(console.error);
        }

    } else if (interaction.commandName === 'logged-trn') {
        const trn = normalizeTRN(interaction.options.get('trn', true).value as string);
        const entry = todaysTrains.get(trn);
        if (entry) {
            await interaction.reply({
                embeds: [
                    {
                        title: `Logged entry for ${trn}`,
                        fields: [
                            { name: 'Description', value: entry.description, inline: true },
                            { name: 'Source', value: entry.source, inline: true }
                        ]
                    }
                ]
            });
        } else {
            await interaction.reply({
                content: `❌ No entry found for "${trn}" in today's log.`,
                flags: ["Ephemeral"]
            });
        }

    } else if (interaction.commandName === 'search-logged-trains') {
        const query = (interaction.options.get('query', true).value as string).toLowerCase();
        const results = Array.from(todaysTrains.entries())
            .filter(([_, entry]) => entry.description.toLowerCase().includes(query));
        if (results.length > 0) {
            const embed = new EmbedBuilder()
                .setTitle(`🔍 Search results for "${query}"`)
                .addFields(
                    results.map(([trn, entry]) => ({
                        name: trn,
                        value: `${entry.description}\n-# ${entry.source}`,
                    })).slice(0, MAX_SEARCH_RESULTS)
                );
            if (results.length > MAX_SEARCH_RESULTS) {
                embed.setFooter({ text: `Only showing first ${MAX_SEARCH_RESULTS} results out of ${results.length}` });
            }
            await interaction.reply({ embeds: [embed] });
        } else {
            await interaction.reply({
                content: `❌ No entries found matching "${query}".`
            });
        }

    } else if (interaction.commandName === 'usage') {
        await interaction.reply(`**About this bot** — I'm the bot used for logging trains spotted day by day on the Tyne and Wear Metro network. To submit a train for the day, use </log-train:${logTrainCommandId}>. As you type the command, Discord will show you the command options and describe what to put in them. Once you've made a submission, it will be sent to Metrowatch's contributor team for approval. Once approved, it will be added to <#${logChannel.id}>. Contributors may also post it in <#1333358653721415710> or <#1377249182116479027> if relevant.`);
    }
}

async function handleButtonInteraction(interaction: ButtonInteraction) {
    if (interaction.customId.startsWith("confirm-update:")) {
        const uuid = interaction.customId.split(':')[1];
        const entry = unconfirmedEntries.get(uuid);
        if (entry) {
            const deferUpdatePromise = interaction.deferUpdate().catch(console.error);
            const result = await submitEntryUpdate(
                entry.user, entry.trn, { description: entry.description, source: entry.source }
            );
            await deferUpdatePromise;
            interaction.editReply({
                content: result,
                embeds: [],
                components: []
            }).catch(console.error);
            unconfirmedEntries.delete(uuid);
        } else {
            interaction.reply({
                content: '❌ Your submission has expired. Please try again.',
                flags: ["Ephemeral"]
            }).catch(console.error);
        }
    } else {
        const submission = publicSubmissions.get(interaction.message.id);
        if (!submission) {
            interaction.reply({
                content: '❌ This submissions no longer exists.',
                flags: ["Ephemeral"]
            }).catch(console.error);
            return;
        }

        if (!isContributor(interaction.user)) {
            interaction.reply({
                content: '❌ You do not have permission to manage submissions.',
                flags: ["Ephemeral"]
            }).catch(console.error);
            return;
        }

        if (interaction.customId === 'deny') {
            // Denying doesn't affect the log, so no need to defer the update
            await interaction.update(await denySubmission(interaction, submission));
        } else {
            const deferUpdatePromise = interaction.deferUpdate().catch(console.error);
            const result = interaction.customId === 'approve'
                ? await approveSubmission(interaction, submission)
                : await undoApprovedSubmission(interaction, submission);
            await deferUpdatePromise;
            interaction.editReply(result).catch(console.error);
        }
    }
}

async function startNewLog() {
    todaysTrains.clear();
    publicSubmissions.clear();
    currentLogMessage = await logChannel.send(generateDailyLogContent());
    console.log(`Started new log for ${new Date().toISOString().split('T')[0]}`);
}

client.once('ready', async () => {
    console.log(`Logged in as @${client.user.tag}!`);

    logChannel = client.channels.cache.get(LOG_CHANNEL_ID) as TextChannel;
    if (!logChannel) {
        console.error(`Log channel with ID ${LOG_CHANNEL_ID} not found.`);
        process.exit(1);
    }
    approvalChannel = client.channels.cache.get(APPROVAL_CHANNEL_ID) as TextChannel;
    if (!approvalChannel) {
        console.error(`Approval channel with ID ${APPROVAL_CHANNEL_ID} not found.`);
        process.exit(1);
    }
    contributorGuild = client.guilds.cache.get(CONTRIBUTOR_GUILD_ID);
    if (CONTRIBUTOR_GUILD_ID && !contributorGuild) {
        console.error(`Contributor guild with ID ${CONTRIBUTOR_GUILD_ID} not found.`);
        process.exit(1);
    }

    const commands = await client.application.commands.set([
        {
            name: 'log-train',
            description: 'Log a train entry for the day.',
            options: [
                {
                    name: 'trn',
                    type: 3, // string
                    description: 'What the train is running as (e.g., "T101", "brake testing"...)',
                    required: true,
                    maxLength: 32
                },
                {
                    name: 'description',
                    type: 3, // string
                    description: 'A description of the train (e.g., "4073+4081")',
                    required: true,
                    maxLength: 128
                },
                {
                    name: 'source',
                    type: 3, // string
                    description: 'Source of the information (defaults to you)',
                    maxLength: 128
                }
            ]
        },
        {
            name: 'remove-train',
            description: "Remove a train entry from today's log.",
            options: [
                {
                    name: 'trn',
                    type: 3, // string
                    description: 'The TRN of the train to remove',
                    required: true,
                    maxLength: 32
                }
            ]
        },
        {
            name: 'logged-trn',
            description: 'Get the currently logged information for a given TRN.',
            options: [
                {
                    name: 'trn',
                    type: 3, // string
                    description: 'The TRN of the train to look up (e.g., "T101")',
                    required: true,
                    maxLength: 32
                }
            ]
        },
        {
            name: 'search-logged-trains',
            description: "Search through the descriptions of all of today's trains.",
            options: [
                {
                    name: 'query',
                    type: 3, // string
                    description: 'Text to search for in train descriptions',
                    required: true,
                    maxLength: 16
                }
            ]
        },
        {
            name: 'usage',
            description: 'Sends a message explaining basic usage of the bot.'
        }
    ]);
    logTrainCommandId = commands.find(cmd => cmd.name === 'log-train').id;

    await startNewLog();
    const now = new Date();
    const nextRun = new Date();
    nextRun.setHours(3, 0, 0, 0);
    if (now.getHours() >= 3) {
        nextRun.setDate(nextRun.getDate() + 1);
    }
    setTimeout(async () => {
        await startNewLog();
        setInterval(startNewLog, 24 * 60 * 60 * 1000);
    }, nextRun.getTime() - now.getTime());
});

client.on('interactionCreate', async (interaction) => {
    if (interaction.isChatInputCommand()) {
        await handleCommandInteraction(interaction);
    } else if (interaction.isButton()) {
        await handleButtonInteraction(interaction);
    }
});

client.login(process.env.DISCORD_TOKEN).catch(console.error);
