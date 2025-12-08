import {createGoogleGenerativeAI, GoogleGenerativeAIProvider} from '@ai-sdk/google';
import {generateObject, jsonSchema} from "ai";
import {config} from "dotenv";
import { readFileSync } from 'fs';
import {
    ActionRowBuilder,
    ButtonBuilder,
    CommandInteraction, MessageContextMenuCommandInteraction, Snowflake, User,
    ButtonStyle, APISelectMenuOption, TextInputStyle,
    ChatInputCommandInteraction, TextInputComponentData, StringSelectMenuComponentData, ButtonInteraction,
    ModalSubmitInteraction,
} from "discord.js";
import {
    DailyLog,
    JSONModal,
    LogEntryDetails,
    LogEntryKey,
    LogRemoveTransaction,
    LogTransaction, NLPConversation, NlpSubmission,
} from "./types";
import {addUnconfirmedSubmission} from "./bot";
import {getIdLoggers, listTransactions} from "./utils";

config();
const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY;
const WIKI_API_URL = "https://metro.hopperelec.co.uk/wiki/api.php";
const WIKI_QUERY = "[[Has unit identifier::+]]|?Has unit identifier|?Has unit status|limit=200";

let google: GoogleGenerativeAIProvider;
let systemPrompt: string;
let unitStatuses: Record<string, string>;
const clarificationForms = new Map<Snowflake, {
    messages: NLPConversation;
} & JSONModal>();

if (GOOGLE_AI_API_KEY) {
    google = createGoogleGenerativeAI({ apiKey: GOOGLE_AI_API_KEY });
    systemPrompt = readFileSync('nlp-system-prompt.md', 'utf-8');
    loadWikiData();
} else {
    console.warn('Warning: GOOGLE_AI_API_KEY is not set. AI features will be disabled.');
}

// For compactness, details are merged into the main object
interface NlpLogEntry extends LogEntryKey, LogEntryDetails {}

function loadWikiData() {
    unitStatuses = {};
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
}

async function runPrompt(
    interaction: CommandInteraction | ModalSubmitInteraction,
    messages: NLPConversation,
    currentLog: DailyLog, // for context in confirmations
): Promise<void> {
    if (!google) throw new Error('Google Generative AI is not configured.');

    const {logWithId, warnWithId, errorWithId} = getIdLoggers(interaction.id);
    logWithId('Running AI prompt', messages);

    const deferReplyPromise = interaction.deferReply({flags: ['Ephemeral']}).catch(errorWithId);
    try {
        const response = await generateObject({
            model: google('gemini-2.5-flash'),
            schema: jsonSchema<{
                type: "accept";
                transactions: (LogRemoveTransaction | (
                    { type: "add" } & NlpLogEntry
                ))[];
                notes?: string;
            } | ({
                type: "clarify";
            } & JSONModal) | {
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
                            type: {const: "clarify"},
                            title: {
                                type: "string",
                                minLength: 1,
                                maxLength: 45
                            },
                            components: {
                                type: "array",
                                items: {
                                    oneOf: [
                                        {
                                            type: "object",
                                            properties: {
                                                type: {const: "TextDisplay"},
                                                content: {
                                                    type: "string",
                                                    minLength: 1,
                                                    maxLength: 2000
                                                },
                                            },
                                            required: ["type", "content"],
                                            additionalProperties: false
                                        },
                                        {
                                            type: "object",
                                            properties: {
                                                type: {const: "TextInput"},
                                                style: {
                                                    type: "string",
                                                    enum: ["Short", "Paragraph"]
                                                },
                                                id: {
                                                    type: "string",
                                                    minLength: 1,
                                                    maxLength: 100
                                                },
                                                label: {
                                                    type: "string",
                                                    minLength: 1,
                                                    maxLength: 45
                                                },
                                                placeholder: {
                                                    type: "string",
                                                    maxLength: 1000
                                                },
                                                value: {
                                                    type: "string",
                                                    maxLength: 4000
                                                },
                                                minLength: {
                                                    type: "integer",
                                                    minimum: 0,
                                                    maximum: 4000
                                                },
                                                maxLength: {
                                                    type: "integer",
                                                    minimum: 1,
                                                    maximum: 4000
                                                },
                                                required: {type: "boolean"}
                                            },
                                            required: ["type", "style", "id", "label"],
                                            additionalProperties: false
                                        },
                                        {
                                            type: "object",
                                            properties: {
                                                type: {const: "DropdownInput"},
                                                id: {
                                                    type: "string",
                                                    minLength: 1,
                                                    maxLength: 100
                                                },
                                                label: {
                                                    type: "string",
                                                    minLength: 1,
                                                    maxLength: 45
                                                },
                                                placeholder: {
                                                    type: "string",
                                                    maxLength: 100
                                                },
                                                minValues: {
                                                    type: "integer",
                                                    minimum: 0,
                                                    maximum: 25
                                                },
                                                maxValues: {
                                                    type: "integer",
                                                    minimum: 1,
                                                    maximum: 25
                                                },
                                                options: {
                                                    type: "array",
                                                    items: {
                                                        type: "object",
                                                        properties: {
                                                            label: {
                                                                type: "string",
                                                                minLength: 1,
                                                                maxLength: 100
                                                            },
                                                            value: {
                                                                type: "string",
                                                                minLength: 1,
                                                                maxLength: 100
                                                            },
                                                            description: {
                                                                type: "string",
                                                                maxLength: 100
                                                            }
                                                        },
                                                        required: ["label", "value"],
                                                        additionalProperties: false
                                                    },
                                                    minItems: 1,
                                                    maxItems: 25
                                                }
                                            },
                                            required: ["type", "id", "label", "options"],
                                            additionalProperties: false
                                        }
                                    ]
                                },
                                minItems: 1,
                                maxItems: 5
                            }
                        },
                        required: ["type", "title", "components"],
                        additionalProperties: false,
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
            messages,
            temperature: 0,
        });
        await deferReplyPromise;

        messages.push({role: 'assistant', content: JSON.stringify(response.object)});
        switch (response.finishReason) {
            case 'stop':
            default: // still try parsing in miscellaneous cases; the try/catch will handle errors
                logWithId('AI response received', response.object);

                // Somehow, the AI is capable of bypassing the schema, so we have to do extra checks
                if (!response.object.type) {
                    warnWithId('AI response missing type field');
                    await interaction.editReply('Sorry, but the AI generated an invalid response.').catch(errorWithId);
                    return;
                }
                switch (response.object.type) {
                    case 'accept':
                        if (!Array.isArray(response.object.transactions)) {
                            warnWithId("AI accepted but didn't include the transactions field:");
                            let message = 'The AI accepted your query but did not provide any changes to make.';
                            if (response.object.notes) {
                                message += `\n**Notes by AI:** ${response.object.notes}`;
                            }
                            await interaction.editReply(message);
                            return;
                        }

                        const transactions: LogTransaction[] = [];
                        for (const transaction of response.object.transactions) {
                            if (!(
                                'type' in transaction &&
                                typeof transaction.trn === 'string' &&
                                typeof transaction.units === 'string'
                            )) {
                                warnWithId('AI provided malformed transaction', transaction);
                                continue;
                            }
                            if (transaction.type === 'remove') {
                                transactions.push(transaction);
                                continue;
                            }
                            // Move details into 'details' object
                            const {type, trn, units, ...details} = transaction;
                            if (!(
                                type === 'add' &&
                                typeof details.sources === 'string' &&
                                (details.notes === undefined || typeof details.notes === 'string') &&
                                (details.index === undefined || typeof details.index === 'number') &&
                                (details.withdrawn === undefined || typeof details.withdrawn === 'boolean')
                            )) {
                                warnWithId('AI provided malformed transaction', transaction);
                                continue;
                            }
                            transactions.push({type, trn, units, details});
                        }
                        if (transactions.length === 0) {
                            warnWithId('AI accepted but provided no valid transactions');
                            let message = 'The AI accepted your query but did not provide any valid changes to make.';
                            if (response.object.notes) {
                                message += `\n**Notes by AI:** ${response.object.notes}`;
                            }
                            await interaction.editReply(message).catch(errorWithId);
                            return;
                        }

                        // The transactions are valid; show confirmation prompt
                        const lines = [
                            "**Do these changes look correct?**",
                            listTransactions(transactions, currentLog)
                        ];
                        if (response.object.notes) {
                            lines.push(`**Notes by AI:** ${response.object.notes}`);
                        }
                        addUnconfirmedSubmission(interaction.id, {
                            user: interaction.user,
                            transactions,
                            messages,
                        });
                        await interaction.editReply({
                            content: lines.join('\n'),
                            components: [
                                new ActionRowBuilder<ButtonBuilder>()
                                    .addComponents(
                                        new ButtonBuilder()
                                            .setCustomId(`confirm-update:${interaction.id}`)
                                            .setLabel('Confirm')
                                            .setStyle(ButtonStyle.Primary)
                                            .setEmoji('✅'),
                                        new ButtonBuilder()
                                            .setCustomId(`nlp-correction:${interaction.id}`)
                                            .setLabel('Make correction')
                                            .setStyle(ButtonStyle.Secondary)
                                            .setEmoji('✏️')
                                    ),
                            ],
                        }).catch(errorWithId);
                        return;

                    case 'clarify':
                        if (!(
                            typeof response.object.title === 'string' &&
                            Array.isArray(response.object.components) &&
                            response.object.components.every(c =>
                                (c.type === 'TextDisplay' && typeof c.content === 'string') ||
                                (c.type === 'TextInput' &&
                                    typeof c.style === 'string' &&
                                    typeof c.id === 'string' &&
                                    typeof c.label === 'string' &&
                                    (c.placeholder === undefined || typeof c.placeholder === 'string') &&
                                    (c.value === undefined || typeof c.value === 'string') &&
                                    (c.minLength === undefined || typeof c.minLength === 'number') &&
                                    (c.maxLength === undefined || typeof c.maxLength === 'number') &&
                                    (c.required === undefined || typeof c.required === 'boolean')
                                ) ||
                                (c.type === 'DropdownInput' &&
                                    typeof c.id === 'string' &&
                                    (c.placeholder === undefined || typeof c.placeholder === 'string') &&
                                    (c.minValues === undefined ||  typeof c.minValues === 'number') &&
                                    (c.maxValues === undefined ||  typeof c.maxValues === 'number') &&
                                    Array.isArray(c.options) && c.options.every((o: any) =>
                                        typeof o.label === 'string' &&
                                        typeof o.value === 'string' &&
                                        (o.description === undefined || typeof o.description === 'string')
                                    )
                                )
                            )
                        )) {
                            warnWithId("AI requested clarification but didn't include a valid form:", response.object);
                            await interaction.editReply('Sorry, the AI requested clarification but did not provide a valid form for you to complete.').catch(errorWithId);
                            return;
                        }
                        clarificationForms.set(interaction.id, {
                            messages,
                            title: response.object.title,
                            components: response.object.components
                        });
                        await interaction.editReply({
                            content: "The AI has asked for clarification. Please click the button below to open the clarification form.",
                            components: [
                                new ActionRowBuilder<ButtonBuilder>()
                                    .addComponents(
                                        new ButtonBuilder()
                                            .setCustomId(`clarify-open:${interaction.id}`)
                                            .setLabel('Open Clarification Form')
                                            .setStyle(ButtonStyle.Primary)
                                            .setEmoji('📋')
                                    )
                            ]
                        }).catch(errorWithId);
                        return;

                    case 'reject':
                        if (response.object.detail) {
                            await interaction.editReply(response.object.detail).catch(errorWithId);
                        } else {
                            warnWithId('AI rejected but provided no detail');
                            await interaction.editReply('Sorry, the AI rejected your query but did not provide a reason.').catch(errorWithId);
                        }
                        return;

                    default:
                        warnWithId('AI response has unknown type');
                        await interaction.editReply('Sorry, but the AI generated an invalid response.').catch(errorWithId);
                        return;
                }
            // fallthrough (shouldn't happen)
            case 'content-filter':
                warnWithId('AI response rejected by content filter');
                await interaction.editReply('Sorry, but the AI refused to process your request due to content restrictions.').catch(errorWithId);
                return;
            case 'tool-calls':
                warnWithId('AI response triggered tool calls unexpectedly');
                await interaction.editReply('Sorry, but for some reason the AI triggered tool calls instead of generating a proper response.').catch(errorWithId);
                return;
            case 'error':
                warnWithId('Error during AI response generation');
                await interaction.editReply('Sorry, but there was an error while the AI was generating a response.').catch(errorWithId);
                return;
        }
    } catch (error) {
        errorWithId('Exception during AI prompt processing', error);
        await interaction.editReply('Sorry, there was an error processing your request. Please try again later.').catch(errorWithId);
    }
}

function formatInitialPrompt(prompt: string, user: User, currentLog: DailyLog): NLPConversation {
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
    return [{
        role: 'user',
        content: [
            `Wiki Unit Statuses: ${Object.keys(unitStatuses || {}).length ? JSON.stringify(unitStatuses) : 'Unavailable'}`,
            `Existing Logs: ${JSON.stringify(formattedLog)}`,
            `Prompting user: <@${user.id}>`,
            'Everything after this line is the user prompt:',
            prompt
        ].join('\n')
    }];
}

export async function aiLogCommand(currentLog: DailyLog, interaction: ChatInputCommandInteraction): Promise<void> {
    if (!google) {
        await interaction.reply('AI logging is currently unavailable. Contact the bot developer if you believe this is an error.').catch(console.error);
        return;
    }

    const prompt = interaction.options.get('prompt', true).value as string;
    console.log(`/ai-log invoked by @${interaction.user.tag}`);
    await runPrompt(interaction, formatInitialPrompt(prompt, interaction.user, currentLog), currentLog);
}

export async function aiLogContextMenu(currentLog: DailyLog, interaction: MessageContextMenuCommandInteraction) {
    if (!google) {
        await interaction.reply('AI logging is currently unavailable. Contact the bot developer if you believe this is an error.').catch(console.error);
        return;
    }

    const prompt = interaction.targetMessage.content;
    console.log(`AI Log Context Menu invoked by @${interaction.user.tag} on message ${interaction.targetMessage.id}: ${prompt}`);
    await runPrompt(interaction, formatInitialPrompt(prompt, interaction.user, currentLog), currentLog);
}

export async function openClarificationForm(uuid: string, interaction: ButtonInteraction) {
    const {errorWithId} = getIdLoggers(uuid);

    const form = clarificationForms.get(uuid);
    if (!form) {
        await interaction.reply({
            content: 'Sorry, this clarification form has expired or is invalid.',
            flags: ['Ephemeral']
        }).catch(errorWithId);
        return;
    }

    await interaction.showModal({
        title: form.title,
        customId: `clarify:${uuid}`,
        components: form.components.map((component) => {
            switch (component.type) {
                case 'TextDisplay':
                    return {
                        ...component,
                        type: 10,
                    };

                case 'TextInput': {
                    const {type, id, label, ...rest} = component;
                    return {
                        type: 18,
                        label,
                        component: {
                            ...rest,
                            customId: id,
                            type: 4,
                            style: TextInputStyle[component.style],
                        } as TextInputComponentData
                    };
                }

                case 'DropdownInput': {
                    const {type, id, label, options, ...rest} = component;
                    return {
                        type: 18,
                        label,
                        component: {
                            customId: id,
                            type: 3,
                            options: options.map((opt) => ({
                                label: opt.label,
                                value: opt.value,
                                description: opt.description,
                            })) as APISelectMenuOption[],
                            required: rest.minValues !== 0,
                            ...rest,
                        } as StringSelectMenuComponentData
                    };
                }
            }
        })
    }).catch(async error => {
        errorWithId('Error showing clarification modal', {
            form,
            error
        });
        await interaction.reply({
            content: 'Sorry, there was an error opening the clarification form.',
            flags: ['Ephemeral']
        }).catch(errorWithId);
    });
}

export async function clarificationFormSubmission(uuid: string, interaction: ModalSubmitInteraction, currentLog: DailyLog) {
    const form = clarificationForms.get(uuid);
    if (!form) {
        await interaction.reply({
            content: 'Sorry, this clarification form has expired or is invalid.',
            flags: ['Ephemeral']
        }).catch(getIdLoggers(uuid).errorWithId);
        return;
    }
    clarificationForms.delete(uuid);
    await runPrompt(interaction, [
        ...form.messages,
        {
            role: 'user',
            content: JSON.stringify(interaction.fields.fields),
        }
    ], currentLog);
}

export async function openNlpCorrectionForm(uuid: string, interaction: ButtonInteraction) {
    await interaction.showModal({
        title: 'Correction to AI Submission',
        customId: `correction:${uuid}`,
        components: [
            {
                type: 18,
                label: 'Describe the correction you want to make',
                component: {
                    type: 4,
                    customId: 'correction',
                    style: TextInputStyle.Paragraph,
                } as TextInputComponentData
            }
        ]
    }).catch(console.error);
}

export async function nlpCorrectionFormSubmission(
    interaction: ModalSubmitInteraction,
    currentLog: DailyLog,
    originalSubmission: NlpSubmission
) {
    const messages: NLPConversation = [
        ...originalSubmission.messages,
        {
            role: 'user',
            content: interaction.fields.getTextInputValue('correction')
        }
    ];
    await runPrompt(interaction, messages, currentLog);
}

export function cleanup() {
    clarificationForms.clear();
    loadWikiData();
}
