import {
    Snowflake,
    User,
    TextInputStyle,
    StringSelectMenuComponentData, SelectMenuComponentOptionData, TextInputComponentData, TextDisplayComponentData
} from 'discord.js';

// Core types

export type TRN = string;
export type TrainUnits = string;
export type TrnCategory = 'green' | 'yellow' | 'other';

export interface LogEntryKey {
    trn: TRN;
    units: TrainUnits;
}

export interface LogEntryDetails {
    sources: string;
    notes?: string;
    index?: number;
    withdrawn?: boolean;
}

export interface LogEntry extends LogEntryKey {
    details: LogEntryDetails;
}

export type DailyLog = Record<TRN, Record<TrainUnits, LogEntryDetails>>;

// Transactions

export interface LogAddTransaction extends LogEntry {
    type: 'add';
}

export interface LogRemoveTransaction extends LogEntryKey {
    type: 'remove';
}

export type LogTransaction = LogAddTransaction | LogRemoveTransaction;

// Submissions

interface ManualSubmission {
    user: User;
    transactions: LogTransaction[];
}

export interface NlpSubmission extends ManualSubmission {
    messages: NLPConversation;
    summary: string;
}

export type Submission = ManualSubmission | NlpSubmission;

export interface ExecutedSubmission extends ManualSubmission {
    submissionId: Snowflake;
    undoTransactions: LogTransaction[];
}

// NLP messages

interface Message {
    content: string;
}

interface UserMessage extends Message {
    role: 'user';
}

interface AssistantMessage extends Message {
    role: 'assistant';
}

type NLPMessage = UserMessage | AssistantMessage;

export type NLPConversation = [NLPMessage & {role: 'user'}, ...NLPMessage[]];

// NLP clarification modal

interface JSONTextDisplay extends Omit<TextDisplayComponentData, 'type'> {
    type: 'TextDisplay';
}

interface JSONTextInput extends Omit<TextInputComponentData, 'type' | 'id' | 'customId' | 'style'> {
    type: 'TextInput';
    id: string;
    label: string; // Technically already exists in TextInputComponentData but is deprecated so may be removed in future versions
    style: keyof typeof TextInputStyle;
}

interface JSONStringSelect extends Omit<StringSelectMenuComponentData, 'type' | 'id' | 'customId'> {
    type: 'DropdownInput';
    id: string;
    label: string;
    options: Omit<SelectMenuComponentOptionData, 'emoji'>[];
}

export interface JSONModal {
    title: string;
    components: (JSONTextDisplay | JSONTextInput | JSONStringSelect)[];
}
