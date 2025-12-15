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
    ChatInputCommandInteraction, GuildMember, StringSelectMenuBuilder,
    StringSelectMenuInteraction, ButtonComponent, ActionRow, MessageActionRowComponent,
} from 'discord.js';
import { config } from 'dotenv';
import {normalizeTRN} from "./normalization";
import {
    DailyLog,
    ExecutedSubmission, LogAddTransaction, LogTransaction,
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
import {categorizeTRN, dailyLogToString, detailsToString, invertTransactions, listTransactions} from "./utils";
import {
    addMessage,
    getAllocation,
    getAllocationsForTRN,
    getTodaysLog,
    loadTodaysLog,
    removeMessage,
    runTransactions
} from "./db";

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
export const NEW_DAY_HOUR = 3;

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
let currentLogMessage: Message | Partial<Record<TrnCategory, Message>>;
const unconfirmedSubmissions = new Map<Snowflake, Submission>();
const unconfirmedIntentSubmissions = new Map<Snowflake, LogAddTransaction>
const submissionsForApproval = new Map<Snowflake, Submission>();
const executedHistory = new Map<Snowflake, ExecutedSubmission>();

async function logTransaction(message: string | BaseMessageOptions): Promise<void | Message> {
    if (transactionChannel) return sendMessageWithoutPinging(message, transactionChannel).then();
}

export function addUnconfirmedSubmission(id: Snowflake, submission: Submission) {
    unconfirmedSubmissions.set(id, submission);
}

export async function searchMembers(guild: Guild, queries: string[]): Promise<GuildMember[]> {
    const results = await Promise.all(queries.map(async (query) => {
        try {
            const search = await guild.members.search({ query, limit: 5 });
            return [...search.values()];
        } catch (e) {
            console.error(e);
            return [];
        }
    }));
    const uniqueResults = new Map<Snowflake, GuildMember>();
    for (const member of results.flat()) {
        uniqueResults.set(member.id, member);
    }
    return [...uniqueResults.values()];
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

async function sendMessageWithoutPinging(content: string | BaseMessageOptions, channel: TextChannel): Promise<Message> {
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

async function sendLogMessage(content: string | BaseMessageOptions): Promise<Message> {
    const message = await sendMessageWithoutPinging(content, logChannel);
    await addMessage(message);
    return message;
}

async function editOrSendLogMessage(message: Message, content: string | BaseMessageOptions) {
    try {
        return await message.edit(
            typeof content === 'string'
                ? { content, files: [] }: // Remove files if they were previously attached
                content
        )
    } catch {
        // If the message was deleted or something went wrong, send a new one
        let newMessage: Message;
        await Promise.all([
            (async () => {
                newMessage = await sendLogMessage(content);
            })(),
            removeMessage(message)
        ])
        return newMessage;
    }
}

async function updateLogMessage() {
    const categories: Record<string, DailyLog> = {};
    for (const [trn, allocs] of Object.entries(getTodaysLog())) {
        const line = categorizeTRN(trn);
        if (!categories[line]) categories[line] = {};
        categories[line][trn] = allocs;
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
        let content: string;
        if (!categories.green && !categories.yellow && !categories.other) {
            content = '*No allocations have been logged yet today. Check back here later!*';
        } else {
            content = `${renderSingleMessageCategory('green')}\n${renderSingleMessageCategory('yellow')}`;
            if (categories.other) {
                content += `\n${renderSingleMessageCategory('other')}`;
            }
        }

        if (content.length > CHARACTER_LIMIT) {
            currentLogMessage = {
                green: await editOrSendLogMessage(currentLogMessage, renderMultipleMessageCategory('green')),
                yellow: await sendLogMessage(renderMultipleMessageCategory('yellow')),
            }
            if (categories.other) {
                currentLogMessage.other = await sendLogMessage(renderMultipleMessageCategory('other'));
            }
        } else {
            currentLogMessage = await editOrSendLogMessage(currentLogMessage, content);
        }
    } else {
        currentLogMessage.green = await editOrSendLogMessage(currentLogMessage.green, renderMultipleMessageCategory('green'));
        currentLogMessage.yellow = await editOrSendLogMessage(currentLogMessage.yellow, renderMultipleMessageCategory('yellow'));
        if (currentLogMessage.other) {
            // Modified implementation of `editOrSendMessage` to only re-send if there are other workings
            const content = renderMultipleMessageCategory('other');
            try {
                currentLogMessage.other = await currentLogMessage.other.edit(content);
            } catch {
                if (categories.other) {
                    currentLogMessage.other = await sendLogMessage(content);
                } else {
                    await removeMessage(currentLogMessage.other);
                    delete currentLogMessage.other;
                }
            }
        } else if (categories.other) {
            currentLogMessage.other = await sendLogMessage(renderMultipleMessageCategory('other'));
        }
    }
}

async function submitSubmission(submission: Submission): Promise<string> {
    if (isContributor(submission.user)) {
        const listedTransactionsEmojis = listTransactions(submission.transactions);
        const listedTransactionsConsole = listTransactions(submission.transactions, { add: '+', remove: '-' });
        const undoTransactions = invertTransactions(submission.transactions);
        try {
            await runTransactions(submission.transactions);
        } catch (e) {
            console.error(`@${submission.user.tag} tried to apply the following changes to the log, but an error occurred:\n${listedTransactionsConsole}\nError: ${e}`);
            return '❌ There was an error applying your changes to the log.';
        }
        await updateLogMessage();
        console.log(`Submission by contributor @${submission.user.tag} applied directly to log:\n${listedTransactionsConsole}`);

        const embed = new EmbedBuilder()
            .setTitle('Train log amended')
            .setColor(0x00ff00)
            .setDescription(listedTransactionsEmojis)
            .setFooter({ text: `By ${submission.user.tag}`, iconURL: submission.user.displayAvatarURL() });
        if ('summary' in submission && submission.summary) {
            embed.addFields({ name: 'Summary', value: submission.summary });
        }
        const message = await logTransaction({
            embeds: [embed],
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
        });
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

    const embed = new EmbedBuilder()
        .setTitle('Train gen submission')
        .setColor(0xff9900)
        .setDescription(listTransactions(submission.transactions))
        .setFooter({ text: `By ${submission.user.tag}`, iconURL: submission.user.displayAvatarURL() });
    if ('summary' in submission && submission.summary) {
        embed.addFields({ name: 'Summary', value: submission.summary });
    }
    const message = await approvalChannel.send({
        embeds: [embed],
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

    console.log(`Submission by @${submission.user.tag} submitted for approval:\n${listTransactions(submission.transactions, { add: '+', remove: '-' })}`);
    return '📋 Your gen has been submitted for approval by contributors.';
}

async function approveSubmission(interaction: ButtonInteraction, submission: Submission) {
    console.log(`Submission ${interaction.message.id} approved by @${interaction.user.tag}`);

    const listedTransactions = listTransactions(submission.transactions);
    const inverse = invertTransactions(submission.transactions);
    try {
        await runTransactions(submission.transactions);
    } catch (e) {
        console.error(e);
        return '❌ There was an error applying these changes to the log.';
    }
    await updateLogMessage();
    executedHistory.set(interaction.message.id, {
        submissionId: interaction.message.id,
        user: interaction.user,
        transactions: submission.transactions,
        undoTransactions: inverse
    });

    const embed = new EmbedBuilder()
        .setTitle('Train log amended')
        .setColor(0x00ff00)
        .setDescription(listedTransactions)
        .setFooter({
            text: `Submission by ${submission.user.tag}, approved by ${interaction.user.tag}`,
            iconURL: submission.user.displayAvatarURL()
        });
    if ('summary' in submission && submission.summary) {
        embed.addFields({ name: 'Summary', value: submission.summary });
    }
    logTransaction({
        content: `✅ ${interaction.message.url} (submission by <@${submission.user.id}>) approved by <@${interaction.user.id}>`,
        embeds: [embed]
    }).then();

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
    logTransaction(`❌ ${interaction.message.url} (submission by <@${submission.user.id}>) denied by <@${interaction.user.id}>`).then();
    return {
        embeds: [
            new EmbedBuilder()
                .setTitle('Train gen denied')
                .setColor(0xff0000)
                .setDescription(listTransactions(submission.transactions))
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
        await aiLogCommand(interaction);

    } else if (interaction.commandName === 'log-allocation') {
        const trn = normalizeTRN(interaction.options.get('trn', true).value as string);
        const units = interaction.options.get('units', true).value as string;
        const sources = (interaction.options.get('sources')?.value || `<@${interaction.user.id}>`) as string;
        const notes = interaction.options.get('notes')?.value as string | undefined;
        const index = interaction.options.get('index')?.value as number | undefined;
        const withdrawn = interaction.options.get('withdrawn')?.value as boolean | undefined;
        const transaction: LogAddTransaction = {
            type: 'add',
            trn,
            units,
            details: { sources, notes, index, withdrawn }
        };
        const submission: Submission = {
            user: interaction.user,
            transactions: [transaction]
        };

        const existingAlloc = getAllocation(trn, units);
        if (existingAlloc) {
            if (
                existingAlloc.sources === sources &&
                existingAlloc.notes === notes &&
                existingAlloc.index === index &&
                !existingAlloc.withdrawn === !withdrawn
            ) {
                await interaction.reply({
                    content: `❌ This allocation has already been logged with the exact same details.`,
                    flags: ["Ephemeral"]
                });
                return;
            }

            console.log(`User @${interaction.user.tag} attempted to log an existing allocation with different details. Awaiting confirmation to update.`);
            addUnconfirmedSubmission(interaction.id, submission);
            await interaction.reply({
                content: '⚠️ This allocation has already been logged but with different details. Do you want to update the existing allocation?',
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Existing details')
                        .setColor(0xffcc00)
                        .setFields(
                            { name: 'Sources', value: existingAlloc.sources },
                            { name: 'Notes', value: existingAlloc.notes || '*None*' },
                            { name: 'Index', value: existingAlloc.index !== undefined ? existingAlloc.index.toString() : '*None*' },
                            { name: 'Withdrawn', value: existingAlloc.withdrawn ? 'Yes' : 'No' }
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
            return;
        }

        const existingAllocs = getAllocationsForTRN(trn);
        if (existingAllocs && Object.values(existingAllocs).some(alloc => (alloc.index || 0) === (index || 0))) {
            console.log(`User @${interaction.user.tag} attempted to log an allocation with a duplicate index for TRN ${trn}. Awaiting confirmation on intent.`);
            unconfirmedIntentSubmissions.set(interaction.id, transaction);
            await interaction.reply({
                content: '⚠️ An allocation for this TRN already exists with the same index. You may proceed if this was intentional, but consider one of the options provided in the dropdown below first.',
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Existing allocations for this TRN')
                        .setColor(0xffcc00)
                        .setDescription(
                            Object.entries(existingAllocs)
                                .map(([units, details]) => `**${units}** — ${detailsToString(details)}`)
                                .join('\n')
                        )
                ],
                components: [
                    new ActionRowBuilder<StringSelectMenuBuilder>()
                        .addComponents(
                            new StringSelectMenuBuilder()
                                .setCustomId(`duplicate-intent:${interaction.id}`)
                                .setPlaceholder('Select an option')
                                .addOptions(
                                    {
                                        label: 'Keep duplicate index',
                                        description: "Choose this if existing allocations are still valid but there isn't a meaningful order to them",
                                        value: 'keep-duplicate-index',
                                    },
                                    {
                                        label: 'Remove existing allocation(s)',
                                        description: 'Choose this if your new allocation is a correction that replaces the existing ones',
                                        value: 'remove-existing-allocs',
                                    },
                                    {
                                        label: 'Assign a new index for me',
                                        description: 'Choose this if your new allocation logically comes after the existing ones',
                                        value: 'assign',
                                    },
                                    {
                                        label: 'Assign a new index and withdraw existing allocation(s)',
                                        description: 'Choose this if your new allocation is a real-world replacement for the existing ones',
                                        value: 'assign-and-withdraw',
                                    }
                                )
                        ),
                    new ActionRowBuilder<ButtonBuilder>()
                        .addComponents(
                            new ButtonBuilder()
                                .setCustomId(`confirm-update:${interaction.id}`)
                                .setLabel('Confirm')
                                .setStyle(ButtonStyle.Primary)
                                .setEmoji('✏️')
                                .setDisabled(true)
                        )
                ],
                flags: ["Ephemeral"]
            });
            return;
        }

        const deferReplyPromise = interaction.deferReply({ flags: ["Ephemeral"] }).catch(console.error);
        const result = await submitSubmission(submission);
        await deferReplyPromise;
        interaction.editReply(result).catch(console.error);

    } else if (interaction.commandName === 'remove-allocation') {
        const trn = normalizeTRN(interaction.options.get('trn', true).value as string);
        const units = interaction.options.get('units', true).value as string;
        const existingAlloc = getAllocation(trn, units);
        if (!existingAlloc) {
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
        const existingAllocs = getAllocationsForTRN(trn);
        if (existingAllocs) {
            await interaction.reply(dailyLogToString({ [trn]: existingAllocs }));
        } else {
            await interaction.reply(`❌ Nothing has been logged for TRN "${trn}" today.`);
        }

    } else if (interaction.commandName === 'search-unit') {
        const query = (interaction.options.get('query', true).value as string).toLowerCase();
        const results: DailyLog = {};
        for (const [trn, allocations] of Object.entries(getTodaysLog())) {
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
            if (!submission) {
                interaction.reply({
                    content: '❌ Your submission has expired. Please try again.',
                    flags: ["Ephemeral"]
                }).catch(console.error);
                return;
            }
            const deferUpdatePromise = interaction.deferUpdate().catch(console.error);
            const result = await submitSubmission(submission);
            await deferUpdatePromise;
            interaction.editReply({
                content: result,
                embeds: [],
                components: []
            }).catch(console.error);
            unconfirmedSubmissions.delete(uuid);
            unconfirmedIntentSubmissions.delete(uuid);
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

        const listedTransactions = listTransactions(executed.undoTransactions);
        try {
            await runTransactions(executed.undoTransactions);
        } catch (e) {
            console.error(`@${interaction.user.tag} tried to undo action ${interaction.message.id}, but an error occurred.`, e);
            interaction.reply({ content: '❌ There was an error undoing this action.', flags: ["Ephemeral"] }).catch(console.error);
            return;
        }
        await updateLogMessage();
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
        }).then();
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

async function handleIntentSelectionInteraction(interaction: StringSelectMenuInteraction) {
    const [action, uuid] = interaction.customId.split(':');
    if (action !== 'duplicate-intent') {
        console.warn(`Unknown select menu interaction: ${interaction.customId}`);
        return;
    }

    const transaction = unconfirmedIntentSubmissions.get(uuid);
    if (!transaction) {
        interaction.reply({
            content: '❌ Your submission has expired. Please try again.',
            flags: ["Ephemeral"]
        }).catch(console.error);
        return;
    }
    const transactionCopy = structuredClone(transaction);
    const transactions: LogTransaction[] = [transactionCopy];
    const existingAllocs = getAllocationsForTRN(transaction.trn);

    const selected = interaction.values[0];
    if (selected !== 'keep-duplicate-index') {
        if (selected === 'remove-existing-allocs' || selected === 'assign-and-withdraw') {
            const unitsWithDuplicateIndex = Object.entries(existingAllocs)
                .filter(([, details]) => (details.index || 0) === (transaction.details.index || 0))
                .map(([units]) => units);
            for (const units of unitsWithDuplicateIndex) {
                if (selected === 'remove-existing-allocs') {
                    transactions.push({
                        type: 'remove',
                        trn: transaction.trn,
                        units
                    });
                } else {
                    transactions.push({
                        type: 'add',
                        trn: transaction.trn,
                        units,
                        details: {
                            ...existingAllocs[units],
                            withdrawn: true
                        }
                    });
                }
            }
        }
        if (selected === 'assign' || selected === 'assign-and-withdraw') {
            transactionCopy.details.index = Math.max(0, ...Object.values(existingAllocs).map(details => details.index || 0)) + 1;
        }
    }

    unconfirmedSubmissions.set(uuid, {
        user: interaction.user,
        transactions
    });
    const confirmButton = ButtonBuilder.from((interaction.message.components[1] as ActionRow<MessageActionRowComponent>).components[0] as ButtonComponent);
    confirmButton.setDisabled(false);
    await interaction.update({
        embeds: [
            new EmbedBuilder()
                .setTitle('Existing allocations for this TRN')
                .setColor(0xffcc00)
                .setDescription(
                    Object.entries(existingAllocs)
                        .map(([units, details]) => `**${units}** — ${detailsToString(details)}`)
                        .join('\n')
                ),
            new EmbedBuilder()
                .setTitle('Changes that will be made')
                .setColor(0x00ccff)
                .setDescription(listTransactions(transactions))
        ],
        components: [
            interaction.message.components[0],
            new ActionRowBuilder<ButtonBuilder>().addComponents(confirmButton),
        ]
    }).catch(console.error);
}

async function handleAutocompleteInteraction(interaction: AutocompleteInteraction) {
    function emptyResponse() {
        interaction.respond([]).catch(console.error);
    }

    const focused = interaction.options.getFocused(true);
    if (focused.name === 'trn') {
        const trn = (focused.value as string).toLowerCase();
        interaction.respond(
            Object.keys(getTodaysLog())
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
        const todaysLog = getTodaysLog();
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
        const existingValue: string | number = getAllocation(trn, units)?.[focused.name];
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
    submissionsForApproval.clear();
    executedHistory.clear();
    cleanupNLP();

    const messageIds = await loadTodaysLog();
    if (messageIds.length === 0) {
        currentLogMessage = await sendLogMessage('*No allocations have been logged yet today. Check back here later!*');
        await logTransaction('📝 New log started');
    } else {
        if (messageIds.length === 1) {
            currentLogMessage = await logChannel.messages.fetch(messageIds[0]);
        } else {
            const messages = await Promise.all(messageIds.map(id => logChannel.messages.fetch(id)));
            messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
            currentLogMessage = {
                green: messages[0],
                yellow: messages[1],
                other: messages[2]
            };
        }
        await logTransaction('📝 Existing log loaded');
    }

    const now = new Date();
    const nextRun = new Date();
    nextRun.setHours(NEW_DAY_HOUR, 0, 0, 0);
    if (now.getHours() >= NEW_DAY_HOUR) {
        nextRun.setDate(nextRun.getDate() + 1);
    }
    setTimeout(startNewLog, nextRun.getTime() - now.getTime());
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
                    // Don't auto-complete, so that Discord provides mentions
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
});

client.on('interactionCreate', async (interaction) => {
    if (interaction.isChatInputCommand()) {
        await handleCommandInteraction(interaction);
    } else if (interaction.isButton()) {
        await handleButtonInteraction(interaction);
    } else if (interaction.isStringSelectMenu()) {
        await handleIntentSelectionInteraction(interaction);
    } else if (interaction.isAutocomplete()) {
        await handleAutocompleteInteraction(interaction);
    } else if (interaction.isMessageContextMenuCommand()) {
        if (interaction.commandName === 'Log with AI') {
            await aiLogContextMenu(interaction);
        }
    } else if (interaction.isModalSubmit()) {
        const [action,uuid] = interaction.customId.split(':');
        if (action === 'clarify') {
            await clarificationFormSubmission(uuid, interaction);
        } else if (action === 'correction') {
            const submission = unconfirmedSubmissions.get(uuid);
            if (!('messages' in submission)) {
                interaction.reply({
                    content: '❌ Sorry, this submission is no longer available.',
                    flags: ["Ephemeral"]
                }).catch(console.error);
                return;
            }
            await nlpCorrectionFormSubmission(interaction, submission);
        }
    }
});

client.login(process.env.DISCORD_TOKEN).catch(console.error);
