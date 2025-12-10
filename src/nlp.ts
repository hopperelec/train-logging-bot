import {FinishReason, generateObject} from "ai";
import {createGoogleGenerativeAI} from '@ai-sdk/google';
import {createGroq} from "@ai-sdk/groq";
import {createOpenRouter, LanguageModelV2} from "@openrouter/ai-sdk-provider";
import {createOpenAICompatible} from "@ai-sdk/openai-compatible";
import {config} from "dotenv";
import { readFileSync } from 'fs';
import {
    ActionRowBuilder,
    ButtonBuilder,
    CommandInteraction, MessageContextMenuCommandInteraction, Snowflake, User,
    ButtonStyle, APISelectMenuOption, TextInputStyle,
    ChatInputCommandInteraction, TextInputComponentData, StringSelectMenuComponentData, ButtonInteraction,
    ModalSubmitInteraction, InteractionEditReplyOptions,
} from "discord.js";
import {DailyLog, JSONModal, LogTransaction, NLPConversation, NlpSubmission} from "./types";
import {addUnconfirmedSubmission} from "./bot";
import {getIdLoggers, listTransactions} from "./utils";
import nlpSchema, {NlpLogEntry, NlpResponse} from "./nlp-schema";

config();
const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const NVIDIA_NIM_API_KEY = process.env.NVIDIA_NIM_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const WIKI_API_URL = "https://metro.hopperelec.co.uk/wiki/api.php";
const WIKI_QUERY = "[[Has unit identifier::+]]|?Has unit identifier|?Has unit status|limit=200";

// Model Hierarchy: Best to Worst
const MODELS: {
    name?: string;
    model: LanguageModelV2;
}[] = [];

// Fallback State References
// We track the index of the "lowest quality model disabled".
// If index 1 is disabled, index 0 is also effectively disabled for this request flow.
// -1 means none disabled.
// Expiry timestamps are in milliseconds since epoch.
let minuteDisabledIndex = -1;
let minuteExpiry = 0;
let dayDisabledIndex = -1;
let dayExpiry = 0;

let systemPrompt: string;
let unitStatuses: Record<string, string>;
const clarificationForms = new Map<Snowflake, {
    messages: NLPConversation;
} & JSONModal>();

if (GOOGLE_AI_API_KEY) {
    const google = createGoogleGenerativeAI({ apiKey: GOOGLE_AI_API_KEY });
    MODELS.push(
        {
            name: 'Gemini 2.5 Flash',
            model: google('gemini-2.5-flash')
        },
        {
            name: 'Gemini 2.5 Flash Lite',
            model: google('gemini-2.5-flash-lite')
        },
        {
            name: 'Gemini 2.0 Flash',
            model: google('gemini-2.0-flash')
        }
    );
}
if (GROQ_API_KEY) {
    const groq = createGroq({apiKey: GROQ_API_KEY});
    MODELS.push({
        name: 'gpt-oss-120b via Groq',
        model: groq('openai/gpt-oss-120b'),
    });
}
if (OPENROUTER_API_KEY) {
    const openrouter = createOpenRouter({apiKey: OPENROUTER_API_KEY});
    MODELS.push({
        name: 'gpt-oss-120b via OpenRouter',
        model: openrouter('openai/gpt-oss-120b:free')
    });
}
if (NVIDIA_NIM_API_KEY) {
    // Broken: NVIDIA NIM seems to finish thinking then never provide the actual response
    const nim = createOpenAICompatible({
        name: 'nim',
        baseURL: 'https://integrate.api.nvidia.com/v1',
        headers: {
            Authorization: `Bearer ${NVIDIA_NIM_API_KEY}`,
        },
    });
    MODELS.push({
        name: 'gpt-oss-120b via NVIDIA NIM',
        model: nim('openai/gpt-oss-120b')
    });
}

if (MODELS.length === 0) {
    console.warn('No AI models are configured. AI logging will be disabled.');
} else {
    systemPrompt = readFileSync('nlp-system-prompt.md', 'utf-8');
    loadWikiData();
}

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

function getNextMidnightPT(now: Date): Date {
    const reset = new Date();
    reset.setUTCHours(8, 0, 0, 0); // 00:00 PT is 08:00 UTC
    if (reset.getTime() <= now.getTime()) {
        reset.setDate(reset.getDate() + 1);
    }
    return reset;
}

async function runPrompt(
    interaction: CommandInteraction | ModalSubmitInteraction,
    messages: NLPConversation,
    currentLog: DailyLog, // for context in confirmations
): Promise<void> {
    const {logWithId, warnWithId, errorWithId} = getIdLoggers(interaction.id);
    logWithId('Running AI prompt', messages);

    const deferReplyPromise = interaction.deferReply({flags: ['Ephemeral']}).catch(errorWithId);

    // Try models from best to worst until one works without rate limiting
    if (Date.now() > dayExpiry) {
        dayDisabledIndex = -1;
    }
    const effectiveMinuteIndex = Date.now() > minuteExpiry ? -1 : minuteDisabledIndex;
    let response: {object: NlpResponse, finishReason: FinishReason};
    let modelName: string;
    for (let i = Math.max(effectiveMinuteIndex, dayDisabledIndex) + 1; i < MODELS.length; i++) {
        modelName = MODELS[i].name
        logWithId(`Attempting model: ${modelName}`);
        try {
            response = await generateObject({
                model: MODELS[i].model,
                schema: nlpSchema,
                system: systemPrompt,
                messages,
                temperature: 0,
                providerOptions: {
                    groq: {
                        reasoningEffort: 'high'
                    }
                }
            });
            if (i === minuteDisabledIndex) {
                minuteDisabledIndex = -1;
            }
            break;
        } catch (error: any) {
            if (error?.lastError?.statusCode === 429) {
                warnWithId(`Rate limit hit on ${modelName}`);

                if (i <= minuteDisabledIndex) {
                    warnWithId(`Disabling ${modelName} (and higher) until midnight PT.`);
                    dayDisabledIndex = i;
                    dayExpiry = getNextMidnightPT(
                        error?.lastError?.responseHeaders?.date // Use server time if available
                            ? new Date(error.lastError.responseHeaders.date)
                            : new Date()
                    ).getTime();
                } else {
                    warnWithId(`Disabling ${modelName} (and higher) until next minute.`);
                    minuteDisabledIndex = i;
                    minuteExpiry = Math.ceil(Date.now() / 60000) * 60000;
                }
                continue;
            }

            errorWithId(`Exception with model ${modelName}`, error);
            await deferReplyPromise;
            await interaction.editReply('Sorry, there was an error processing your request. Please try again later.').catch(errorWithId);
            return;
        }
    }
    await deferReplyPromise;

    if (!response) {
        warnWithId('All AI models exhausted or rate limited.');
        await interaction.editReply('Sorry, all AI models are currently busy. Please try again later.').catch(errorWithId);
        return;
    }

    function replyWithModel(options: string | InteractionEditReplyOptions) {
        if (typeof options === 'string') {
            options += `\n-# Model used: ${modelName}`;
        } else {
            options.content += `\n-# Model used: ${modelName}`;
        }
        interaction.editReply(options).catch(errorWithId);
    }

    try {
        messages.push({role: 'assistant', content: JSON.stringify(response.object)});
        switch (response.finishReason) {
            case 'stop':
            default: // still try parsing in miscellaneous cases; the try/catch will handle errors
                logWithId('AI response received', response.object);

                // Schema isn't always enforced properly, so we need to validate it ourselves
                if (!response.object.type) {
                    warnWithId('AI response missing type field');
                    replyWithModel('Sorry, but the AI generated an invalid response.');
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
                            replyWithModel(message);
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
                            replyWithModel(message);
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
                        replyWithModel({
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
                        });
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
                            replyWithModel('Sorry, the AI requested clarification but did not provide a valid form for you to complete.');
                            return;
                        }
                        clarificationForms.set(interaction.id, {
                            messages,
                            title: response.object.title,
                            components: response.object.components
                        });
                        replyWithModel({
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
                        });
                        return;

                    case 'reject':
                        if (response.object.detail) {
                            replyWithModel(response.object.detail);
                        } else {
                            warnWithId('AI rejected but provided no detail');
                            replyWithModel('Sorry, the AI rejected your query but did not provide a reason.');
                        }
                        return;

                    default:
                        warnWithId('AI response has unknown type');
                        replyWithModel('Sorry, but the AI generated an invalid response.');
                        return;
                }
            // fallthrough (shouldn't happen)
            case 'content-filter':
                warnWithId('AI response rejected by content filter');
                replyWithModel('Sorry, but the AI refused to process your request due to content restrictions.');
                return;
            case 'tool-calls':
                warnWithId('AI response triggered tool calls unexpectedly');
                replyWithModel('Sorry, but for some reason the AI triggered tool calls instead of generating a proper response.');
                return;
            case 'error':
                warnWithId('Error during AI response generation');
                replyWithModel('Sorry, but there was an error while the AI was generating a response.');
                return;
        }
    } catch (error) {
        errorWithId('Exception during AI prompt processing', error);
        replyWithModel('Sorry, there was an error processing your request. Please try again later.');
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
    if (MODELS.length === 0) {
        await interaction.reply('AI logging is currently unavailable. Contact the bot developer if you believe this is an error.').catch(console.error);
        return;
    }

    const prompt = interaction.options.get('prompt', true).value as string;
    console.log(`/ai-log invoked by @${interaction.user.tag}`);
    await runPrompt(interaction, formatInitialPrompt(prompt, interaction.user, currentLog), currentLog);
}

export async function aiLogContextMenu(currentLog: DailyLog, interaction: MessageContextMenuCommandInteraction) {
    if (MODELS.length === 0) {
        await interaction.reply('AI logging is currently unavailable. Contact the bot developer if you believe this is an error.').catch(console.error);
        return;
    }

    const prompt = interaction.targetMessage.content;
    console.log(`AI Log Context Menu invoked by @${interaction.user.tag} on message ${interaction.targetMessage.id}`);
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
