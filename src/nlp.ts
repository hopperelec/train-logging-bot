import {createGoogleGenerativeAI, GoogleGenerativeAIProvider} from '@ai-sdk/google';
import {generateObject, jsonSchema} from "ai";
import {config} from "dotenv";
import { readFileSync } from 'fs';
import {
    ActionRowBuilder,
    ButtonBuilder,
    CommandInteraction, MessageContextMenuCommandInteraction, User,
} from "discord.js";
import {DailyLog, LogEntryDetails, LogEntryKey, LogRemoveTransaction, LogTransaction} from "./types";
import {addUnconfirmedEntry} from "./bot";
import {listTransactions} from "./utils";

config();
const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY;
const WIKI_API_URL = "https://metro.hopperelec.co.uk/wiki/api.php";
const WIKI_QUERY = "[[Has unit identifier::+]]|?Has unit identifier|?Has unit status|limit=200";

let google: GoogleGenerativeAIProvider;
let systemPrompt: string;
let unitStatuses: Record<string, string>;

if (GOOGLE_AI_API_KEY) {
    google = createGoogleGenerativeAI({ apiKey: GOOGLE_AI_API_KEY });
    systemPrompt = readFileSync('nlp-system-prompt.txt', 'utf-8');

    fetch(
        `${WIKI_API_URL}?action=ask&format=json&query=${encodeURIComponent(WIKI_QUERY)}`,
        { headers: { 'User-Agent': 'train-logging-bot' } }
    ).then(res => res.json())
        .then((data) => {
            unitStatuses = {};
            for (const page of Object.values(data.query.results) as any[]) {
                unitStatuses[page.printouts['Has unit identifier'][0]] = page.printouts['Has unit status'][0] || 'Unknown';
            }
        })
        .catch(console.error);
} else {
    console.warn('Warning: GOOGLE_AI_API_KEY is not set. AI features will be disabled.');
}

// For compactness, details are merged into the main object
interface NlpLogEntry extends LogEntryKey, LogEntryDetails {}

async function runPrompt(
    interaction: CommandInteraction | MessageContextMenuCommandInteraction,
    prompt: string,
    userToCredit: User,
    currentLog: DailyLog
) {
    if (!google) throw new Error('Google Generative AI is not configured.');

    const formattedLog: NlpLogEntry[] = [];
    for (const [trn, unitsMap] of Object.entries(currentLog)) {
        for (const [units, details] of Object.entries(unitsMap)) {
            formattedLog.push({
                trn,
                units,
                ...details
            });
        }
    }

    const deferReplyPromise = interaction.deferReply({flags: ['Ephemeral']}).catch(console.error);
    try {
        const response = await generateObject({
            model: google('gemini-2.5-flash'),
            schema: jsonSchema<{
                type: "accept";
                transactions: (LogRemoveTransaction | (
                    { type: "add" } & NlpLogEntry
                ))[];
                notes?: string;
            } | {
                type: "reject";
                detail: string;
            }>({
                type: "object",
                oneOf: [
                    {
                        type: "object",
                        properties: {
                            type: {const: "accept"},
                            transactions: {
                                type: "array",
                                items: {
                                    oneOf: [
                                        {
                                            type: "object",
                                            properties: {
                                                type: {const: "add"},
                                                trn: {type: "string"},
                                                units: {type: "string"},
                                                sources: {type: "string"},
                                                notes: {type: "string"},
                                                index: {type: "integer"},
                                                withdrawn: {type: "boolean"}
                                            },
                                            required: ["type", "trn", "units", "sources"],
                                            additionalProperties: false
                                        },
                                        {
                                            type: "object",
                                            properties: {
                                                type: {const: "remove"},
                                                trn: {type: "string"},
                                                units: {type: "string"}
                                            },
                                            required: ["type", "trn", "units"],
                                            additionalProperties: false
                                        }
                                    ]
                                },
                                minItems: 1
                            },
                            notes: {type: "string"}
                        },
                        required: ["type", "transactions"],
                        additionalProperties: false
                    },
                    {
                        type: "object",
                        properties: {
                            type: {const: "reject"},
                            detail: {type: "string"}
                        },
                        required: ["type", "detail"],
                        additionalProperties: false
                    }
                ]
            }),
            system: systemPrompt,
            prompt: [
                `Wiki Unit Statuses: ${Object.keys(unitStatuses || {}).length ? JSON.stringify(unitStatuses) : 'Unavailable'}`,
                `Existing Logs: ${JSON.stringify(formattedLog)}`,
                `Prompt given by user <@${userToCredit.id}>:`,
                prompt
            ].join('\n'),
            temperature: 0,
        });
        await deferReplyPromise;

        switch (response.finishReason) {
            case 'stop':
            // hope for the best in miscellaneous cases
            case 'other':
            case 'unknown':
                switch (response.object.type) {
                    case 'accept':
                        const transactions: LogTransaction[] = response.object.transactions.map(transaction => {
                            if (transaction.type === 'remove') return transaction;
                            // Move details into 'details' object
                            const {trn, units, ...details} = transaction;
                            return {
                                type: 'add',
                                trn, units, details
                            }
                        });
                        const lines = [
                            "**Do these changes look correct?**",
                            listTransactions(transactions, currentLog)
                        ];
                        if (response.object.notes) {
                            lines.push(`**Notes by AI:** ${response.object.notes}`);
                        }
                        await interaction.editReply({
                            content: lines.join('\n'),
                            components: [
                                new ActionRowBuilder<ButtonBuilder>()
                                    .addComponents(
                                        addUnconfirmedEntry({
                                            user: interaction.user,
                                            transactions,
                                        })
                                    )
                            ],
                        }).catch(console.error);
                        return;
                    case 'reject':
                        await interaction.editReply(response.object.detail).catch(console.error);
                        return;
                }
            // fallthrough (shouldn't happen)
            case 'length':
                console.warn('AI response too long');
                await interaction.editReply('Sorry, but the response generated by the AI was too long.').catch(console.error);
                return;
            case 'content-filter':
                console.warn('AI response rejected by content filter');
                await interaction.editReply('Sorry, but the AI refused to process your request due to content restrictions.').catch(console.error);
                return;
            case 'tool-calls':
                console.warn('AI response triggered tool calls unexpectedly');
                await interaction.editReply('Sorry, but for some reason the AI triggered tool calls instead of generating a proper response.').catch(console.error);
                return;
            case 'error':
                console.warn('Error during AI response generation');
                await interaction.editReply('Sorry, but there was an error while the AI was generating a response.').catch(console.error);
                return;
        }
    } catch (error) {
        console.error(error);
        await interaction.editReply('Sorry, there was an error processing your request. Please try again later.').catch(console.error);
    }
}


export async function aiLogCommand(currentLog: DailyLog, interaction: CommandInteraction): Promise<void> {
    if (!google) {
        await interaction.reply('AI logging is currently unavailable. Contact the bot developer if you believe this is an error.').catch(console.error);
        return;
    }

    const prompt = interaction.options.get('prompt', true).value as string;
    console.log(`/ai-log invoked by @${interaction.user.tag}: ${prompt}`);
    await runPrompt(interaction, prompt, interaction.user, currentLog);
}

export async function aiLogContextMenu(currentLog: DailyLog, interaction: MessageContextMenuCommandInteraction) {
    if (!google) {
        await interaction.reply('AI logging is currently unavailable. Contact the bot developer if you believe this is an error.').catch(console.error);
        return;
    }

    const prompt = interaction.targetMessage.content;
    console.log(`AI Log Context Menu invoked by @${interaction.user.tag} on message ID ${interaction.targetMessage.id}: ${prompt}`);
    await runPrompt(interaction, prompt, interaction.targetMessage.author, currentLog);
}
