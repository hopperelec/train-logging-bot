import {User} from "discord.js";

export type TRN = string;
export type GenEntry = {
    description: string;
    source: string;
}
export type Submission = GenEntry & {
    user: User;
    trn: TRN;
    previous?: GenEntry; // previous entry (for undoing)
}
export type TrnCategory = 'green' | 'yellow' | 'other';
