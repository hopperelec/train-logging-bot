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
    Message, GuildMember, User
} from 'discord.js';
import { config } from 'dotenv';

config();
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const APPROVAL_CHANNEL_ID = process.env.APPROVAL_CHANNEL_ID;
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
if (!CONTRIBUTOR_ROLE_ID) {
    console.warn('Missing CONTRIBUTOR_ROLE_ID environment variable. Anyone will be able to log entries.');
}

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

let logChannel: TextChannel;
let approvalChannel: TextChannel;
let currentLogMessage: Message;
const todaysMetrocars = new Map<TRN, GenEntry>();
const publicSubmissions = new Map<Message, GenEntry & {
    user: User;
    trn: TRN;
    source?: string;
    previous?: GenEntry; // previous entry (for undoing)
}>();

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

function generateDailyLogContent() {
    if (todaysMetrocars.size === 0) return '*No metrocars have been logged yet today. Check back here later!*';

    const categories: Record<string, ({ trn: TRN } & GenEntry)[]> = {};
    for (const [trn, entry] of todaysMetrocars.entries()) {
        const line = categorizeTRN(trn);
        if (!categories[line]) categories[line] = [];
        categories[line].push({ trn, ...entry });
    }

    let content = '### Green line\n';
    if (categories.green) {
        content += categories.green.sort((a, b) => a.trn.localeCompare(b.trn)).map(renderEntry).join('\n');
    } else {
        content += '*No metrocars have been logged on the green line yet.*';
    }
    content += '\n### Yellow line\n';
    if (categories.yellow) {
        content += categories.yellow.sort((a, b) => a.trn.localeCompare(b.trn)).map(renderEntry).join('\n');
    } else {
        content += '*No metrocars have been logged on the yellow line yet.*';
    }
    if (categories.other) {
        content += '\n### Other workings\n';
        content += categories.other.sort((a, b) => a.trn.localeCompare(b.trn)).map(renderEntry).join('\n');
    }
    return content;
}

async function updateLogMessage() {
    try {
        await currentLogMessage.edit(generateDailyLogContent());
    } catch {
        // If the message was deleted or something went wrong, create a new one
        currentLogMessage = await logChannel.send(generateDailyLogContent());
    }
}

async function logEntry(trn: TRN, entry: GenEntry) {
    todaysMetrocars.set(trn, entry);
    await updateLogMessage();
}

async function removeEntry(trn: TRN) {
    if (todaysMetrocars.delete(trn)) {
        await updateLogMessage();
    }
}

async function submitForApproval(trn: TRN, entry: GenEntry & { source?: TRN }, interaction: CommandInteraction) {
    if (!approvalChannel) {
        await interaction.reply({
            content: '❌ Only contributors can log metrocars right now.',
            flags: ["Ephemeral"]
        });
        return;
    }

    const embed = new EmbedBuilder()
        .setTitle('Metrocar gen submission')
        .setColor(0xff9900)
        .addFields(
            { name: 'TRN', value: trn, inline: true },
            { name: 'Description', value: entry.description, inline: true },
            { name: 'Submitted by', value: `<@${interaction.user.id}>`, inline: true }
        );
    if (entry.source) {
        embed.addFields({ name: 'Source', value: entry.source });
    }

    const row = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`approve`)
                .setLabel('Approve')
                .setStyle(ButtonStyle.Success)
                .setEmoji('✅'),
            new ButtonBuilder()
                .setCustomId(`deny`)
                .setLabel('Deny')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('❌')
        );

    const message = await approvalChannel.send({
        embeds: [embed],
        components: [row]
    });
    publicSubmissions.set(message,
        {
            user: interaction.user,
            trn,
            ...entry,
            previous: todaysMetrocars.get(trn)
        }
    )

    console.log(`New submission (${message.id}) by @${interaction.user.tag}: ${JSON.stringify({ trn, ...entry})}`);
    await interaction.reply({
        content: '📋 Your gen has been submitted for approval by contributors.',
        flags: ["Ephemeral"]
    });
}

function isContributor(member: GuildMember) {
    return !CONTRIBUTOR_ROLE_ID || member.roles.cache.some(role => role.id === CONTRIBUTOR_ROLE_ID);
}

async function handleCommandInteraction(interaction: CommandInteraction) {
    if (interaction.commandName === 'log-metrocar') {
        const trn = normalizeTRN(interaction.options.get('trn', true).value as string);
        const description = interaction.options.get('description', true).value as string;
        const source = interaction.options.get('source')?.value as string;
        if (isContributor(interaction.guild?.members.cache.get(interaction.user.id))) {
            await logEntry(trn, {
                description,
                source: source || `<@${interaction.user.id}>`
            });
            console.log(`Metrocar "${trn}" logged by contributor @${interaction.user.tag}: ${description} (Source: ${source})`);
            await interaction.reply({
                content: `✅ Metrocar "${trn}" has been successfully added to the log!`,
                flags: ["Ephemeral"]
            });
        } else {
            await submitForApproval(trn, { description, source }, interaction);
        }

    } else if (interaction.commandName === 'remove-metrocar') {
        const trn = normalizeTRN(interaction.options.get('trn', true).value as string);
        if (todaysMetrocars.has(trn)) {
            await removeEntry(trn);
            console.log(`Metrocar "${trn}" removed from today's log by @${interaction.user.tag}`);
            await interaction.reply({
                content: `✅ Metrocar "${trn}" has been successfully removed from today's log.`,
                flags: ["Ephemeral"]
            });
        } else {
            await interaction.reply({
                content: `❌ Metrocar "${trn}" is not currently logged for today.`,
                flags: ["Ephemeral"]
            });
        }
    }
}

async function handleButtonInteraction(interaction: ButtonInteraction) {
    const action = interaction.customId;

    const submission = publicSubmissions.get(interaction.message);
    if (!submission) {
        await interaction.reply({
            content: '❌ This submissions no longer exists.',
            flags: ["Ephemeral"]
        });
        return;
    }

    const member = interaction.guild?.members.cache.get(interaction.user.id);
    if (!isContributor(member)) {
        await interaction.reply({
            content: '❌ You do not have permission to manage submissions.',
            flags: ["Ephemeral"]
        });
        return;
    }

    if (action === 'approve') {
        submission.previous = todaysMetrocars.get(submission.trn);
        await logEntry(submission.trn, { description: submission.description, source: submission.source || `<@${submission.user.id}>` });
        console.log(`Submission ${interaction.message.id} approved by @${member.user.tag}`);
        const embed = new EmbedBuilder()
            .setTitle('Metrocar entry approved')
            .setColor(0x00ff00)
            .setDescription(`Approved by <@${interaction.user.id}>`)
            .addFields(
                { name: 'TRN', value: submission.trn, inline: true },
                { name: 'Description', value: submission.description, inline: true },
                { name: 'Submitted by', value: `<@${submission.user.id}>`, inline: true }
            );
        if (submission.source) {
            embed.addFields({ name: 'Source', value: submission.source });
        }
        await interaction.update({
            embeds: [embed],
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
        });
    } else if (action === 'deny' || action === 'undo') {
        if (action === 'undo') {
            if (submission.previous) {
                await logEntry(submission.trn, submission.previous);
            } else {
                await removeEntry(submission.trn);
            }
        }
        console.log(`Submission ${interaction.message.id} denied by @${member.user.tag}`);
        const embed = new EmbedBuilder()
            .setTitle('Metrocar entry denied')
            .setColor(0xff0000)
            .setDescription(`Denied by <@${interaction.user.id}>`)
            .addFields(
                { name: 'TRN', value: submission.trn, inline: true },
                { name: 'Description', value: submission.description, inline: true },
                { name: 'Submitted by', value: `<@${submission.user.id}>`, inline: true }
            );
        if (submission.source) {
            embed.addFields({ name: 'Source', value: submission.source });
        }
        await interaction.update({
            embeds: [embed],
            components: [
                new ActionRowBuilder<ButtonBuilder>()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId(`approve`)
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
        });
    }
}

async function startNewLog() {
    todaysMetrocars.clear();
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

    await client.application.commands.set([
        {
            name: 'log-metrocar',
            description: 'Log a metrocar entry for the day.',
            options: [
                {
                    name: 'trn',
                    type: 3, // string
                    description: 'What the metrocar is running as (e.g., "T101", "brake testing"...)',
                    required: true
                },
                {
                    name: 'description',
                    type: 3, // string
                    description: 'A description of the metrocar (e.g., "4073+4081")',
                    required: true
                },
                {
                    name: 'source',
                    type: 3, // string
                    description: 'Source of the information (defaults to you)',
                }
            ]
        },
        {
            name: 'remove-metrocar',
            description: "Remove a metrocar entry from today's log.",
            options: [
                {
                    name: 'trn',
                    type: 3, // string
                    description: 'The TRN of the metrocar to remove',
                    required: true
                }
            ]
        }
    ]);

    await startNewLog();
    const now = new Date();
    const nextRun = new Date();
    nextRun.setHours(3, 0, 0, 0);
    if (now.getHours() >= 3) {
        nextRun.setDate(nextRun.getDate() + 1);
    }
    const timeUntilNext = nextRun.getTime() - now.getTime();
    setTimeout(async () => {
        await startNewLog();
        setInterval(startNewLog, 24 * 60 * 60 * 1000);
    }, timeUntilNext);
});

client.on('interactionCreate', async (interaction) => {
    if (interaction.isChatInputCommand()) {
        await handleCommandInteraction(interaction);
    } else if (interaction.isButton()) {
        await handleButtonInteraction(interaction);
    }
});

client.login(process.env.DISCORD_TOKEN).catch(console.error);
