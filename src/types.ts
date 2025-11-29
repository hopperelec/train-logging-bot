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

export interface NlpClarification {
    llmQuestion: string;
    userAnswer: string;
}

interface BaseNlpInteraction {
    prompt: string;
}

export interface RejectedNlpInteraction extends BaseNlpInteraction {
    type: 'rejected';
    rejectionReason: string;
    clarification?: NlpClarification;
}

export interface ClarifyingNlpInteraction extends BaseNlpInteraction {
    type: 'clarifying';
    llmQuestion: string;
}

export interface AcceptedNlpInteraction extends BaseNlpInteraction {
    type: 'accepted';
    transactions: LogTransaction[];
    clarification?: NlpClarification;
}

export type NlpInteraction = RejectedNlpInteraction | ClarifyingNlpInteraction | AcceptedNlpInteraction;

// Submissions

interface BaseSubmission {
    user: User;
    transactions: LogTransaction[];
}

export interface ManualSubmission extends BaseSubmission {
    type: 'manual';
}

export interface NlpSubmission extends BaseSubmission, BaseNlpInteraction {
    type: 'nlp';
}

export type Submission = ManualSubmission | NlpSubmission;

export interface ExecutedSubmission extends BaseSubmission {
    submissionId: Snowflake;
    undoTransactions: LogTransaction[];
}
