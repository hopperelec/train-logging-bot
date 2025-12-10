import {
    Client,
    GatewayIntentBits,
    TextChannel,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ButtonInteraction,
    Message,
    User,
    Guild,
    Snowflake,
    BaseMessageOptions,
    ThreadChannel,
    DMChannel, VoiceChannel, CategoryChannel, ThreadOnlyChannel, BaseGuildTextChannel, AutocompleteInteraction,
    ChatInputCommandInteraction,
} from 'discord.js';
import { config } from 'dotenv';
import {normalizeTRN} from "./normalization";
import {
    DailyLog,
    ExecutedSubmission,
    LogTransaction,
    Submission,
    TrnCategory
} from "./types";
import {
    aiLogCommand,
    aiLogContextMenu,
    cleanup as cleanupNLP,
    clarificationFormSubmission, nlpCorrectionFormSubmission,
    openClarificationForm, openNlpCorrectionForm
} from "./nlp";
import {categorizeTRN, dailyLogToString, listTransactions} from "./utils";

config();
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
    console.error('Missing DISCORD_TOKEN environment variable.');
    process.exit(1);
}
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
if (!LOG_CHANNEL_ID) {
    console.error('Missing LOG_CHANNEL_ID environment variable.');
    process.exit(1);
}
const APPROVAL_CHANNEL_ID = process.env.APPROVAL_CHANNEL_ID;
if (!APPROVAL_CHANNEL_ID) {
    console.warn('Missing APPROVAL_CHANNEL_ID environment variable. Non-contributors will not be able to submit entries for approval.');
}
const TRANSACTION_CHANNEL_ID = process.env.TRANSACTION_CHANNEL_ID;
if (!TRANSACTION_CHANNEL_ID) {
    console.warn('Missing TRANSACTION_CHANNEL_ID environment variable. Transactions will only be logged to the console.');
}
const CONTRIBUTOR_GUILD_ID = process.env.CONTRIBUTOR_GUILD_ID;
const CONTRIBUTOR_ROLE_ID = process.env.CONTRIBUTOR_ROLE_ID;
if (!CONTRIBUTOR_GUILD_ID !== !CONTRIBUTOR_ROLE_ID) {
    console.error('Both CONTRIBUTOR_GUILD_ID and CONTRIBUTOR_ROLE_ID must be set if one is set.');
    process.exit(1);
}
if (!CONTRIBUTOR_GUILD_ID) {
    console.warn('Missing CONTRIBUTOR_GUILD_ID and CONTRIBUTOR_ROLE_ID environment variables. Anyone will be able to log entries.');
}

const CHARACTER_LIMIT = 2000; // Discord message character limit

const CATEGORY_HEADERS = {
    green: '### Green line',
    yellow: '### Yellow line',
    other: '### Other workings'
};

const CATEGORY_DISPLAY_NAMES = {
    green: 'green line allocations',
    yellow: 'yellow line allocations',
    other: 'other allocations'
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages
    ]
});

let logChannel: TextChannel;
let approvalChannel: TextChannel;
let transactionChannel: TextChannel;
let contributorGuild: Guild;
let logAllocationCommandId: string;
let aiLogCommandId: string;
let currentLogMessage: Message | Record<TrnCategory, Message>;
let todaysLog: DailyLog = {};
const unconfirmedSubmissions = new Map<Snowflake, Submission>();
const submissionsForApproval = new Map<Snowflake, Submission>();
const executedHistory = new Map<Snowflake, ExecutedSubmission>();

function logTransaction(message: string | BaseMessageOptions) {
    if (transactionChannel) sendMessageWithoutPinging(message, transactionChannel).then();
}

export function addUnconfirmedSubmission(id: Snowflake, submission: Submission) {
    unconfirmedSubmissions.set(id, submission);
}

function replacePingsWithNames(text: string) {
    return text
        // User mentions
        .replace(/<@!?(\d+)>/g, (_, userId) => {
            const user = client.users.cache.get(userId);
            return user ? `@${user.tag}` : `<@${userId}>`;
        })
        // Role mentions
        .replace(/<@&(\d+)>/g, (_, roleId) => {
            const role = contributorGuild?.roles.cache.get(roleId);
            return role ? `@${role.name}` : `<@&${roleId}>`;
        })
}

function replaceDiscordFeaturesWithNames(text: string) {
    return replacePingsWithNames(text)
        // Emojis
        .replace(/<a?:(\w+):\d+>/g, (_, name) => `:${name}:`)
        // Channel mentions
        .replace(/<#(\d+)>/g, (_, channelId) => {
            const channel = client.channels.cache.get(channelId);
            if (channel instanceof BaseGuildTextChannel || channel instanceof ThreadOnlyChannel) return `#${channel.name}`;
            if (channel instanceof VoiceChannel) return `🎤 ${channel.name}`;
            if (channel instanceof ThreadChannel) return `🧵 ${channel.name}`;
            if (channel instanceof CategoryChannel) return `📂 ${channel.name}`;
            if (channel instanceof DMChannel) return `@${channel.recipient.tag}`;
            return `<#${channelId}>`;
        });
}

function renderEmptyCategory(category: TrnCategory): string {
    return `${CATEGORY_HEADERS[category]}\n*No ${CATEGORY_DISPLAY_NAMES[category]} have been logged yet today.*`;
}

async function sendMessageWithoutPinging(content: string | BaseMessageOptions, channel = logChannel) {
    const initialContent = typeof content === 'string' ? replaceDiscordFeaturesWithNames(content) : {
        ...content,
        content: content.content ? replaceDiscordFeaturesWithNames(content.content) : undefined
    }
    const message = await channel.send(initialContent);
    if (typeof content === 'string') {
        if (content === initialContent) return message;
    } else if (typeof initialContent === 'object' && content.content === initialContent.content) {
        return message;
    }
    return await message.edit(content);
}

async function editOrSendMessage(message: Message, content: string | BaseMessageOptions) {
    try {
        return await message.edit(
            typeof content === 'string'
                ? { content, files: [] }: // Remove files if they were previously attached
                content
        )
    } catch {
        // If the message was deleted or something went wrong, send a new one
        return await sendMessageWithoutPinging(content);
    }
}

async function updateLogMessage() {
    const categories: Record<string, DailyLog> = {};
    for (const [trn, entry] of Object.entries(todaysLog)) {
        const line = categorizeTRN(trn);
        if (!categories[line]) categories[line] = {};
        categories[line][trn] = entry;
    }

    function renderSingleMessageCategory(category: TrnCategory) {
        const entries = categories[category];
        if (!entries || Object.keys(entries).length === 0) return renderEmptyCategory(category);
        return `${CATEGORY_HEADERS[category]}\n${dailyLogToString(entries)}`;
    }

    function renderMultipleMessageCategory(category: TrnCategory): string | BaseMessageOptions {
        const entries = categories[category];
        if (!entries || Object.keys(entries).length === 0) return renderEmptyCategory(category);
        const content = `${CATEGORY_HEADERS[category]}\n${dailyLogToString(entries)}`;
        if (content.length > CHARACTER_LIMIT) {
            return {
                content: `${CATEGORY_HEADERS[category]}\nToo many ${CATEGORY_DISPLAY_NAMES[category]} have been logged today to fit in a single message, so they have been attached as a file.`,
                files: [{
                    name: `Log - ${new Date().toISOString().split('T')[0]} - ${category}.txt`,
                    attachment: Buffer.from(replaceDiscordFeaturesWithNames(content))
                }]
            };
        }
        return content;
    }

    if (currentLogMessage instanceof Message) {
        let content = `${renderSingleMessageCategory('green')}\n${renderSingleMessageCategory('yellow')}`;
        if (categories.other) {
            content += `\n${renderSingleMessageCategory('other')}`;
        }
        if (content.length > CHARACTER_LIMIT) {
            currentLogMessage = {
                green: await editOrSendMessage(currentLogMessage, renderMultipleMessageCategory('green')),
                yellow: await sendMessageWithoutPinging(renderMultipleMessageCategory('yellow')),
                other: categories.other ? await sendMessageWithoutPinging(renderMultipleMessageCategory('other')) : undefined
            }
        } else {
            currentLogMessage = await editOrSendMessage(currentLogMessage, content);
        }
    } else {
        currentLogMessage.green = await editOrSendMessage(currentLogMessage.green, renderMultipleMessageCategory('green'));
        currentLogMessage.yellow = await editOrSendMessage(currentLogMessage.yellow, renderMultipleMessageCategory('yellow'));
        if (currentLogMessage.other) {
            // Modified implementation of `editOrSendMessage` to only re-send if there are other workings
            const content = renderMultipleMessageCategory('other');
            try {
                currentLogMessage.other = await currentLogMessage.other.edit(content);
            } catch {
                currentLogMessage.other = categories.other
                    ? await sendMessageWithoutPinging(content)
                    : undefined;
            }
        } else if (categories.other) {
            currentLogMessage.other = await sendMessageWithoutPinging(renderMultipleMessageCategory('other'));
        }
    }
}

function invertTransactions(transactions: LogTransaction[], referenceLog = todaysLog): LogTransaction[] {
    const inverse: LogTransaction[] = [];
    // Process in reverse to maintain state validity
    for (const tx of [...transactions].reverse()) {
        const existingDetails = referenceLog[tx.trn]?.[tx.units];
        if (tx.type === 'add' && !existingDetails) {
            inverse.push({
                type: 'remove',
                trn: tx.trn,
                units: tx.units
            });
        } else {
            inverse.push({
                type: 'add',
                trn: tx.trn,
                units: tx.units,
                details: existingDetails
            });
        }
    }
    return inverse;
}

async function runTransactions(transactions: LogTransaction[]) {
    for (const transaction of transactions) {
        if (transaction.type === 'add') {
            if (!todaysLog[transaction.trn]) {
                todaysLog[transaction.trn] = {};
            }
            todaysLog[transaction.trn][transaction.units] = transaction.details;
        } else if (transaction.type === 'remove') {
            if (todaysLog[transaction.trn]) {
                delete todaysLog[transaction.trn][transaction.units];
                if (Object.keys(todaysLog[transaction.trn]).length === 0) {
                    delete todaysLog[transaction.trn];
                }
            }
        }
    }
    await updateLogMessage();
}

async function submitSubmission(submission: Submission): Promise<string> {
    if (isContributor(submission.user)) {
        const listedTransactions = listTransactions(submission.transactions, todaysLog);
        const undoTransactions = invertTransactions(submission.transactions);
        await runTransactions(submission.transactions);
        console.log(`Submission by contributor @${submission.user.tag} applied directly to log:\n${listedTransactions}`);

        const message = await sendMessageWithoutPinging({
            embeds: [
                new EmbedBuilder()
                    .setTitle('Train log amended')
                    .setColor(0x00ff00)
                    .setDescription(listedTransactions)
                    .setFooter({ text: `By ${submission.user.tag}`, iconURL: submission.user.displayAvatarURL() })
            ],
            components: [
                new ActionRowBuilder<ButtonBuilder>()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('undo')
                            .setLabel('Undo')
                            .setStyle(ButtonStyle.Danger)
                            .setEmoji('↩️')
                    )
            ]
        }, transactionChannel || logChannel);

        if (message) {
            executedHistory.set(message.id, {
                submissionId: message.id,
                ...submission,
                undoTransactions,
            });
        }
        return `✅ Your changes have been applied to the log.`;
    }
    if (!approvalChannel) return '❌ Only contributors can update the log right now.';

    const message = await approvalChannel.send({
        embeds: [
            new EmbedBuilder()
                .setTitle('Train gen submission')
                .setColor(0xff9900)
                .setDescription(listTransactions(submission.transactions, todaysLog))
                .setFooter({ text: `By ${submission.user.tag}`, iconURL: submission.user.displayAvatarURL() })
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
    submissionsForApproval.set(message.id, submission);

    console.log(`Submission by @${submission.user.tag} submitted for approval:\n${listTransactions(submission.transactions, todaysLog)}`);
    return '📋 Your gen has been submitted for approval by contributors.';
}

async function approveSubmission(interaction: ButtonInteraction, submission: Submission) {
    const listedTransactions = listTransactions(submission.transactions, todaysLog);
    const inverse = invertTransactions(submission.transactions);
    await runTransactions(submission.transactions);
    executedHistory.set(interaction.message.id, {
        submissionId: interaction.message.id,
        user: interaction.user,
        transactions: submission.transactions,
        undoTransactions: inverse
    });

    console.log(`Submission ${interaction.message.id} approved by @${interaction.user.tag}`);
    logTransaction({
        content: `✅ ${interaction.message.url} (submission by <@${submission.user.id}>) approved by <@${interaction.user.id}>`,
        embeds: [
            new EmbedBuilder()
                .setTitle('Train log amended')
                .setColor(0x00ff00)
                .setDescription(listedTransactions)
                .setFooter({
                    text: `Submission by ${submission.user.tag}, approved by ${interaction.user.tag}`,
                    iconURL: submission.user.displayAvatarURL()
                })
        ]
    });

    return {
        embeds: [
            new EmbedBuilder()
                .setTitle('Train gen approved')
                .setColor(0x00ff00)
                .setDescription(listedTransactions)
                .setFooter({
                    text: `Submission by ${submission.user.tag}, approved by ${interaction.user.tag}`,
                    iconURL: submission.user.displayAvatarURL()
                })
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
    logTransaction(`❌ ${interaction.message.url} (submission by <@${submission.user.id}>) denied by <@${interaction.user.id}>`);
    return {
        embeds: [
            new EmbedBuilder()
                .setTitle('Train gen denied')
                .setColor(0xff0000)
                .setDescription(listTransactions(submission.transactions, todaysLog))
                .setFooter({
                    text: `Submission by ${submission.user.tag}, denied by ${interaction.user.tag}`,
                    iconURL: submission.user.displayAvatarURL()
                })
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

function isContributor(user: User) {
    return !contributorGuild || contributorGuild.members.cache.get(user.id).roles.cache.some(role => role.id === CONTRIBUTOR_ROLE_ID);
}

async function handleCommandInteraction(interaction: ChatInputCommandInteraction) {
    if (interaction.commandName === 'ai-log') {
        await aiLogCommand(todaysLog, interaction);

    } else if (interaction.commandName === 'log-allocation') {
        const trn = normalizeTRN(interaction.options.get('trn', true).value as string);
        const units = interaction.options.get('units', true).value as string;
        const sources = (interaction.options.get('sources')?.value || `<@${interaction.user.id}>`) as string;
        const notes = interaction.options.get('notes')?.value as string | undefined;
        const index = interaction.options.get('index')?.value as number | undefined;
        const withdrawn = interaction.options.get('withdrawn')?.value as boolean | undefined;
        const submission: Submission = {
            user: interaction.user,
            transactions: [{
                type: 'add',
                trn,
                units,
                details: { sources, notes, index, withdrawn }
            }]
        };

        const existingEntry = todaysLog[trn]?.[units];
        if (existingEntry) {
            if (
                existingEntry.sources === sources &&
                existingEntry.notes === notes &&
                existingEntry.index === index &&
                !existingEntry.withdrawn === !withdrawn
            ) {
                await interaction.reply({
                    content: `❌ This entry is already in the log`,
                    flags: ["Ephemeral"]
                });
                return;
            }

            console.log(`User @${interaction.user.tag} attempted to log an existing allocation with different details. Awaiting confirmation to update.`);
            addUnconfirmedSubmission(interaction.id, submission);
            await interaction.reply({
                content: `⚠️ This allocation has already been logged but with different details. Do you want to update the existing entry?`,
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Existing entry details')
                        .setColor(0xffcc00)
                        .setFields(
                            { name: 'Sources', value: existingEntry.sources },
                            { name: 'Notes', value: existingEntry.notes || '*None*' },
                            { name: 'Index', value: existingEntry.index !== undefined ? existingEntry.index.toString() : '*None*' },
                            { name: 'Withdrawn', value: existingEntry.withdrawn ? 'Yes' : 'No' }
                        )
                ],
                components: [
                    new ActionRowBuilder<ButtonBuilder>()
                        .addComponents(
                            new ButtonBuilder()
                                .setCustomId(`confirm-update:${interaction.id}`)
                                .setLabel('Update')
                                .setStyle(ButtonStyle.Primary)
                                .setEmoji('✏️')
                        )
                ],
                flags: ["Ephemeral"],
            });

        } else {
            const deferReplyPromise = interaction.deferReply({ flags: ["Ephemeral"] }).catch(console.error);
            const result = await submitSubmission(submission);
            await deferReplyPromise;
            interaction.editReply(result).catch(console.error);
        }

    } else if (interaction.commandName === 'remove-allocation') {
        const trn = normalizeTRN(interaction.options.get('trn', true).value as string);
        const units = interaction.options.get('units', true).value as string;
        const existingEntry = todaysLog[trn]?.[units];
        if (!existingEntry) {
            await interaction.reply({
                content: `❌ No such allocation is logged for today.`,
                flags: ["Ephemeral"]
            });
            return;
        }
        const deferReplyPromise = interaction.deferReply({ flags: ["Ephemeral"] }).catch(console.error);
        const result = await submitSubmission({
            user: interaction.user,
            transactions: [{
                type: 'remove',
                trn,
                units
            }]
        });
        await deferReplyPromise;
        interaction.editReply(result).catch(console.error);

    } else if (interaction.commandName === 'search-trn') {
        const trn = normalizeTRN(interaction.options.get('trn', true).value as string);
        const entry = todaysLog[trn];
        if (entry) {
            await interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle(`🔍 Search results for TRN "${trn}"`)
                        .setDescription(dailyLogToString({ [trn]: entry }))
                ]
            });
        } else {
            await interaction.reply(`❌ Nothing has been logged for TRN "${trn}" today.`);
        }

    } else if (interaction.commandName === 'search-unit') {
        const query = (interaction.options.get('query', true).value as string).toLowerCase();
        const results: DailyLog = {};
        for (const [trn, allocations] of Object.entries(todaysLog)) {
            for (const [units, details] of Object.entries(allocations)) {
                if (units.toLowerCase().includes(query)) {
                    if (!results[trn]) results[trn] = {};
                    results[trn][units] = details;
                }
            }
        }
        if (Object.keys(results).length === 0) {
            await interaction.reply(`❌ No logged allocations contain a unit matching "${query}" today.`);
            return;
        }
        const description = dailyLogToString(results);
        if (description.length <= CHARACTER_LIMIT) {
            await interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle(`🔍 Search results for unit "${query}"`)
                        .setDescription(description)
                ]
            });
        } else {
            await interaction.reply({
                content: `🔍 Search results for unit "${query}" are too long to display here, so they have been attached as a file.`,
                files: [{
                    name: `Search results - ${new Date().toISOString().split('T')[0]} - ${query}.txt`,
                    attachment: Buffer.from(replaceDiscordFeaturesWithNames(description))
                }]
            });
        }

    } else if (interaction.commandName === 'usage') {
        await interaction.reply(`**About this bot** — I'm the bot used for logging trains spotted day by day on the Tyne and Wear Metro network. There are two ways to submit changes to the log. The recommended way is </ai-log:${aiLogCommandId}>, which allows you to describe an allocation or some changes to make in any format you like and have an AI make the changes for you. Alternatively, you can manually add/edit an allocation using </log-allocation:${logAllocationCommandId}>. Once you've made a submission, it will be sent to Metrowatch's contributor team for approval. Once approved, it will be added to <#${logChannel.id}>. Check <#1429595223939612823> for more details.`);
    }
}

async function handleButtonInteraction(interaction: ButtonInteraction) {
    const [action, uuid] = interaction.customId.split(':');
    if (uuid) {
        if (action === 'clarify-open') {
            await openClarificationForm(uuid, interaction);
            return;
        }

        if (action === 'nlp-correction') {
            await openNlpCorrectionForm(uuid, interaction);
            return;
        }

        if (action === 'confirm-update') {
            const submission = unconfirmedSubmissions.get(uuid);
            if (submission) {
                const deferUpdatePromise = interaction.deferUpdate().catch(console.error);
                const result = await submitSubmission(submission);
                await deferUpdatePromise;
                interaction.editReply({
                    content: result,
                    embeds: [],
                    components: []
                }).catch(console.error);
                unconfirmedSubmissions.delete(uuid);
            } else {
                interaction.reply({
                    content: '❌ Your submission has expired. Please try again.',
                    flags: ["Ephemeral"]
                }).catch(console.error);
            }
            return;
        }

        console.warn(`Unknown button interaction with UUID: ${interaction.customId}`);
        return;
    }

    if (action === 'undo') {
        if (!isContributor(interaction.user)) {
            interaction.reply({ content: '❌ Only contributors can undo actions.', flags: ["Ephemeral"] }).catch(console.error);
            return;
        }
        const executed = executedHistory.get(interaction.message.id);
        if (!executed) {
            interaction.reply({ content: '❌ This action can no longer be undone.', flags: ["Ephemeral"] }).catch(console.error);
            return;
        }

        const listedTransactions = listTransactions(executed.undoTransactions, todaysLog);
        await runTransactions(executed.undoTransactions);
        executedHistory.delete(interaction.message.id);

        console.log(`Action ${interaction.message.id} undone by @${interaction.user.tag}`);
        logTransaction({
            content: `↩️ ${interaction.message.url} (action by <@${executed.user.id}>) undone by <@${interaction.user.id}>`,
            embeds: [
                new EmbedBuilder()
                    .setTitle('Train log amended')
                    .setColor(0xff0000)
                    .setDescription(listedTransactions)
                    .setFooter({ text: `Undone by ${interaction.user.tag}`, iconURL: executed.user.displayAvatarURL() })
            ]
        });
        interaction.message.edit({
            content: `↩️ This action has been undone by <@${interaction.user.id}>.`,
            components: []
        }).catch(console.error);
        return;
    }

    if (action === 'approve' || action === 'deny') {
        const submission = submissionsForApproval.get(interaction.message.id);
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

        if (action === 'approve') {
            const deferUpdatePromise = interaction.deferUpdate().catch(console.error);
            const result = await approveSubmission(interaction, submission);
            await deferUpdatePromise;
            interaction.editReply(result).catch(console.error);
        } else if (action === 'deny') {
            // Denying doesn't affect the log, so no need to defer the update
            await interaction.update(await denySubmission(interaction, submission));
        }
        return;
    }

    console.warn(`Unknown button interaction: ${interaction.customId}`);
}

async function handleAutocompleteInteraction(interaction: AutocompleteInteraction) {
    function emptyResponse() {
        interaction.respond([]).catch(console.error);
    }

    const focused = interaction.options.getFocused(true);
    if (focused.name === 'trn') {
        const trn = (focused.value as string).toLowerCase();
        interaction.respond(
            Object.keys(todaysLog)
                .filter(key => key.toLowerCase().includes(trn))
                .map(key => ({ name: key, value: key }))
                .slice(0, 25)
        ).catch(console.error);
    } else if (focused.name === 'units') {
        let trn = interaction.options.get('trn')?.value as string;
        if (!trn) {
            emptyResponse();
            return;
        }
        trn = normalizeTRN(trn);
        const units = (focused.value as string).toLowerCase();
        const existingUnits = todaysLog[trn]
        const otherLoggedUnits = Object.entries(todaysLog)
            .filter(([key]) => key !== trn)
            .flatMap(([,allocations]) => Object.keys(allocations));
        const suggestions = [
            ...(existingUnits ? Object.keys(existingUnits) : []),
            ...otherLoggedUnits
        ];
        interaction.respond(
            suggestions
                .filter(key => key.toLowerCase().includes(units))
                .map(units => ({ name: units, value: units }))
                .slice(0, 25)
        ).catch(console.error);
    } else {
        let trn = interaction.options.get('trn')?.value as string;
        const units = interaction.options.get('units')?.value as string;
        if (!trn || !units) {
            emptyResponse();
            return;
        }
        trn = normalizeTRN(trn);
        const existingValue: string | number = todaysLog[trn]?.[units]?.[focused.name];
        if (existingValue === undefined) {
            emptyResponse();
            return;
        }
        interaction.respond([
            { name: existingValue.toString(), value: existingValue.toString() }
        ]).catch(console.error);
    }
}

async function startNewLog() {
    todaysLog = {};
    submissionsForApproval.clear();
    executedHistory.clear();
    cleanupNLP();
    currentLogMessage = await logChannel.send('*No allocations have been logged yet today. Check back here later!*');
    console.log(`Started new log for ${new Date().toISOString().split('T')[0]}`);
    logTransaction('📝 New log started');
}

client.once('clientReady', async () => {
    console.log(`Logged in as @${client.user.tag}!`);

    logChannel = client.channels.cache.get(LOG_CHANNEL_ID) as TextChannel;
    if (!logChannel) {
        console.error(`Log channel with ID ${LOG_CHANNEL_ID} not found.`);
        process.exit(1);
    }
    approvalChannel = client.channels.cache.get(APPROVAL_CHANNEL_ID) as TextChannel;
    if (APPROVAL_CHANNEL_ID && !approvalChannel) {
        console.error(`Approval channel with ID ${APPROVAL_CHANNEL_ID} not found.`);
        process.exit(1);
    }
    transactionChannel = client.channels.cache.get(TRANSACTION_CHANNEL_ID) as TextChannel;
    if (TRANSACTION_CHANNEL_ID && !transactionChannel) {
        console.error(`Transaction channel with ID ${TRANSACTION_CHANNEL_ID} not found.`);
        process.exit(1);
    }
    contributorGuild = client.guilds.cache.get(CONTRIBUTOR_GUILD_ID);
    if (CONTRIBUTOR_GUILD_ID && !contributorGuild) {
        console.error(`Contributor guild with ID ${CONTRIBUTOR_GUILD_ID} not found.`);
        process.exit(1);
    }

    const commands = await client.application.commands.set([
        {
            name: 'ai-log',
            description: 'Amend the log using AI.',
            options: [
                {
                    name: 'prompt',
                    type: 3, // string
                    description: "Description of the changes to make to today's log. Please mention sources.",
                    required: true,
                    maxLength: 512
                }
            ]
        },
        {
            name: 'Log with AI',
            type: 3, // message context menu
        },
        {
            name: 'log-allocation',
            description: "Log one of today's allocations.",
            options: [
                {
                    name: 'trn',
                    type: 3, // string
                    description: 'What the train is running as (e.g., "T101", "brake testing"...)',
                    required: true,
                    maxLength: 32,
                    autocomplete: true
                },
                {
                    name: 'units',
                    type: 3, // string
                    description: 'The units allocated (e.g., "4073+4081")',
                    required: true,
                    maxLength: 64,
                    autocomplete: true
                },
                {
                    name: 'sources',
                    type: 3, // string
                    description: "Don't specify if it's just you! Defaults to you",
                    maxLength: 128,
                    autocomplete: true
                },
                {
                    name: 'notes',
                    type: 3, // string
                    description: 'Any notes about the allocation (e.g., testing, driver training, withdrawals...)',
                    maxLength: 64,
                    autocomplete: true
                },
                {
                    name: 'withdrawn',
                    type: 5, // boolean
                    description: 'Mark these units as withdrawn from this TRN (strikes through the units in the log)',
                },
                {
                    name: 'index',
                    type: 4, // integer
                    description: 'ADVANCED - Used for ordering when multiple allocations exist for the same TRN',
                    autocomplete: true
                }
            ]
        },
        {
            name: 'remove-allocation',
            description: "Remove an allocation from today's log.",
            options: [
                {
                    name: 'trn',
                    type: 3, // string
                    description: 'The TRN of the allocation to remove',
                    required: true,
                    maxLength: 32,
                    autocomplete: true
                },
                {
                    name: 'units',
                    type: 3, // string
                    description: 'The units of the allocation to remove',
                    required: true,
                    maxLength: 64,
                    autocomplete: true
                }
            ]
        },
        {
            name: 'search-trn',
            description: 'Get the currently logged allocations for a given TRN.',
            options: [
                {
                    name: 'trn',
                    type: 3, // string
                    description: 'The TRN of the allocations to look up (e.g., "T101")',
                    required: true,
                    maxLength: 32,
                    autocomplete: true
                }
            ]
        },
        {
            name: 'search-unit',
            description: "Get all logged allocations containing the given unit.",
            options: [
                {
                    name: 'query',
                    type: 3, // string
                    description: 'A unit or part of a unit to search for (e.g., "4073")',
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
    logAllocationCommandId = commands.find(cmd => cmd.name === 'log-allocation').id;
    aiLogCommandId = commands.find(cmd => cmd.name === 'ai-log').id;

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
    } else if (interaction.isAutocomplete()) {
        await handleAutocompleteInteraction(interaction);
    } else if (interaction.isMessageContextMenuCommand()) {
        if (interaction.commandName === 'Log with AI') {
            await aiLogContextMenu(todaysLog, interaction);
        }
    } else if (interaction.isModalSubmit()) {
        const [action,uuid] = interaction.customId.split(':');
        if (action === 'clarify') {
            await clarificationFormSubmission(uuid, interaction, todaysLog);
        } else if (action === 'correction') {
            const submission = unconfirmedSubmissions.get(uuid);
            if (!('messages' in submission)) {
                interaction.reply({
                    content: '❌ Sorry, this submission is no longer available.',
                    flags: ["Ephemeral"]
                }).catch(console.error);
                return;
            }
            await nlpCorrectionFormSubmission(interaction, todaysLog, submission);
        }
    }
});

client.login(process.env.DISCORD_TOKEN).catch(console.error);
