import {DailyLog, LogEntry, LogEntryDetails, LogTransaction, TRN, TrnCategory} from "./types";
import {normalizeUnits} from "./normalization";
import {Snowflake} from "discord.js";
import {getTodaysLog} from "./db";

export function getIdLoggers(id: Snowflake) {
    function runWithUUID(func: (...args: string[]) => void, message: string, obj?: any) {
        return obj === undefined
            ? func(`[${id}] ${message}`)
            : func(`[${id}] ${message}`, JSON.stringify(obj));
    }
    return {
        logWithId: (message: string, obj?: any) => runWithUUID(console.log, message, obj),
        warnWithId: (message: string, obj?: any) => runWithUUID(console.warn, message, obj),
        errorWithId: (message: string, obj?: any) => runWithUUID(console.error, message, obj)
    }
}

const TRN_REGEX = new RegExp(/^T?(\d{3})/);
export function categorizeTRN(trn: TRN): TrnCategory {
    const match = trn.match(TRN_REGEX);
    if (!match) return 'other';
    const number = +match[1];
    if (number >= 101 && number <= 112) return 'green';
    if (number >= 121 && number <= 136) return 'yellow';
    return 'other';
}

export function dailyLogToString(dailyLog: DailyLog) {
    return Object.entries(dailyLog)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([trn, allocations]) => {
            const sortedAllocations = Object.entries(allocations)
                .sort(([,a], [,b]) => (a.index ?? 0) - (b.index ?? 0));
            const descriptions = sortedAllocations.map(([units, details]) => {
                units = normalizeUnits(units);
                if (details.withdrawn) units = `~~${units}~~`;
                if (details.notes) units += ` (${details.notes})`;
                return units;
            });
            const sources = sortedAllocations.map(
                ([, details]) => details.sources
            );

            let descriptionStr = descriptions.join('; ');
            if (sortedAllocations.length > 1) {
                const indices = sortedAllocations.map(([, details]) => details.index ?? 0);
                if (new Set(indices).size === sortedAllocations.length) { // All indices are unique
                    const nonWithdrawnIndex = sortedAllocations.findIndex(([, details]) => !details.withdrawn);
                    if (nonWithdrawnIndex === -1) { // All allocations are withdrawn
                        // Each allocation is a replacement for the last
                        descriptionStr = descriptions.join(' then ');
                    } else if (nonWithdrawnIndex === sortedAllocations.length - 1) { // All but the last are withdrawn
                        // Each allocation is a replacement for the last, and the last is not withdrawn
                        descriptionStr = `${descriptions.slice(0, -1).join(' then ')} now ${descriptions[descriptions.length - 1]}`;
                    }
                }
            }

            return `${trn} - ${descriptionStr}\n-# ${sources.join('; ')}`;
        })
        .join('\n');
}

export function detailsToString(details: LogEntryDetails) {
    const parts = [`sources: ${details.sources.replaceAll('|','\\|')}`];
    if (details.notes) {
        parts.push(`notes: ${details.notes.replaceAll('|','\\|')}`);
    }
    if (details.withdrawn) {
        parts.push(`withdrawn`);
    }
    if (details.index !== undefined) {
        parts.push(`index: ${details.index}`);
    }
    return parts.join(' | ');
}

export function entryToString(entry: LogEntry) {
    return `${entry.trn} - ${entry.units} (${detailsToString(entry.details)})`;
}

export function listTransactions(
    transactions: LogTransaction[],
    prefixes: { add: string; remove: string } = { add: '🟩 ', remove: '🟥 ' },
    referenceLog: DailyLog = getTodaysLog()
) {
    return transactions.flatMap(transaction => {
        const lines = []
        const existingDetails = referenceLog[transaction.trn]?.[transaction.units];
        if (existingDetails) {
            lines.push(prefixes.remove + entryToString({
                ...transaction,
                details: existingDetails
            }));
        }
        if (transaction.type === 'add') {
            lines.push(prefixes.add + entryToString(transaction));
        }
        return lines;
    }).join('\n');
}

export function invertTransactions(
    transactions: LogTransaction[],
    referenceLog = getTodaysLog()
): LogTransaction[] {
    const inverse: LogTransaction[] = [];
    // Process in reverse to maintain state validity
    for (const tx of [...transactions].reverse()) {
        const existingDetails = referenceLog[tx.trn]?.[tx.units];
        if (tx.type === 'add' && !existingDetails) {
            inverse.push({
                type: 'remove',
                trn: tx.trn,
                units: tx.units
            });
        } else {
            inverse.push({
                type: 'add',
                trn: tx.trn,
                units: tx.units,
                details: existingDetails
            });
        }
    }
    return inverse;
}
