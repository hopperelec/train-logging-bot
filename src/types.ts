import {Snowflake, User} from "discord.js";

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

// NLP interactions

interface BaseNlpInteraction {
    prompt: string;
}

export interface RejectedNlpInteraction extends BaseNlpInteraction {
    type: 'rejected';
    rejectionReason: string;
}

export interface AcceptedNlpInteraction extends BaseNlpInteraction {
    type: 'accepted';
    transactions: LogTransaction[];
}

export type NlpInteraction = RejectedNlpInteraction | AcceptedNlpInteraction;

// Submissions

export interface Submission {
    user: User;
    transactions: LogTransaction[];
}

export interface ExecutedSubmission extends Submission {
    submissionId: Snowflake;
    undoTransactions: LogTransaction[];
}
