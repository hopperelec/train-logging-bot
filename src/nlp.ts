import {createGoogleGenerativeAI, GoogleGenerativeAIProvider} from '@ai-sdk/google';
import {generateObject, jsonSchema} from "ai";
import {config} from "dotenv";
import { readFileSync } from 'fs';
import {
    ActionRowBuilder,
    ButtonBuilder,
    CommandInteraction,
} from "discord.js";
import {DailyLog, LogEntryKey, LogRemoveTransaction, LogTransaction} from "./types";
import {addUnconfirmedEntry} from "./bot";
import {dailyLogToString, listTransactions} from "./utils";

config();
const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY;

let google: GoogleGenerativeAIProvider;
let systemPrompt: string;

if (GOOGLE_AI_API_KEY) {
    google = createGoogleGenerativeAI({ apiKey: GOOGLE_AI_API_KEY });
    systemPrompt = readFileSync('nlp-system-prompt.txt', 'utf-8');

    // TODO: Dynamically get unit statuses from wiki and include in system prompt
} else {
    console.warn('Warning: GOOGLE_AI_API_KEY is not set. AI features will be disabled.');
}

export async function aiLogCommand(currentLog: DailyLog, interaction: CommandInteraction): Promise<void> {
    if (!google) {
        await interaction.reply('AI logging is currently unavailable. Contact the bot developer if you believe this is an error.').catch(console.error);
        return;
    }

    const prompt = interaction.options.get('prompt', true).value as string;
    console.log(`/ai-log invoked by @${interaction.user.tag}: ${prompt}`);
    const deferReplyPromise = interaction.deferReply({ flags: ['Ephemeral'] }).catch(console.error);
    try {
        const response = await generateObject({
            model: google('gemini-2.5-flash'),
            schema: jsonSchema<{
                type: "accept";
                transactions: (LogRemoveTransaction | (
                    // details aren't nested in AI response
                    {
                        type: "add";
                        sources: string;
                        notes?: string;
                        index?: number;
                        withdrawn?: boolean;
                    } & LogEntryKey
                ))[]
            } | {
                type: "reject";
                detail: string;
            }>({
                type: "object",
                oneOf: [
                    {
                        type: "object",
                        properties: {
                            type: { const: "accept" },
                            transactions: {
                                type: "array",
                                items: {
                                    oneOf: [
                                        {
                                            type: "object",
                                            properties: {
                                                type: { const: "add" },
                                                trn: { type: "string" },
                                                units: { type: "string" },
                                                sources: { type: "string" },
                                                notes: { type: "string" },
                                                index: { type: "integer" },
                                                withdrawn: { type: "boolean" }
                                            },
                                            required: ["type", "trn", "units", "sources"],
                                            additionalProperties: false
                                        },
                                        {
                                            type: "object",
                                            properties: {
                                                type: { const: "remove" },
                                                trn: { type: "string" },
                                                units: { type: "string" }
                                            },
                                            required: ["type", "trn", "units"],
                                            additionalProperties: false
                                        }
                                    ]
                                },
                                minItems: 1
                            }
                        },
                        required: ["type", "transactions"],
                        additionalProperties: false
                    },
                    {
                        type: "object",
                        properties: {
                            type: { const: "reject" },
                            detail: { type: "string" }
                        },
                        required: ["type", "detail"],
                        additionalProperties: false
                    }
                ]
            }),
            system: systemPrompt,
            prompt: `Existing Logs:\n${dailyLogToString(currentLog)}\n\nPrompt given by user <@${interaction.user.id}>: ${prompt}`,
            temperature: 0,
        });
        await deferReplyPromise;

        switch (response.finishReason) {
            case 'stop':
            case 'unknown': // hope for the best!
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
                        await interaction.editReply({
                            content: `Do these changes look correct?\n${listTransactions(transactions, currentLog)}`,
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
            case 'other':
                console.warn('AI response generation stopped for an unknown reason');
                await interaction.editReply('Sorry, but the AI stopped generating a response for an unknown reason.').catch(console.error);
                return;
        }
    } catch (error) {
        console.error(error);
        await deferReplyPromise;
        await interaction.editReply('Sorry, there was an error processing your request. Please try again later.').catch(console.error);
        return;
    }
}
