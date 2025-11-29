import {DailyLog, LogEntry, LogTransaction, TRN, TrnCategory} from "./types";
import {normalizeUnits} from "./normalization";

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
                .sort(([,a], [,b]) => (a.index || 0) - (b.index || 0));
            const descriptions = sortedAllocations.map(([units, details]) => {
                units = normalizeUnits(units);
                if (details.withdrawn) units = `~~${units}~~`;
                if (details.notes) units += ` (${details.notes})`;
                return units;
            });
            const sources = sortedAllocations.map(
                ([, details]) => details.sources
            );
            return `${trn} - ${descriptions.join('; ')}\n-# ${sources.join('; ')}`;
        })
        .join('\n');
}


export function entryToString(entry: LogEntry) {
    const detailsParts = [`source: ${entry.details.sources}`];
    if (entry.details.notes) {
        detailsParts.push(`notes: ${entry.details.notes}`);
    }
    if (entry.details.index !== undefined) {
        detailsParts.push(`index: ${entry.details.index}`);
    }
    return `${entry.trn} - ${entry.details.withdrawn ? `~~${entry.units}~~` : entry.units} (${detailsParts.join(' | ')})`;
}

export function listTransactions(transactions: LogTransaction[], referenceLog: DailyLog) {
    return transactions.flatMap(transaction => {
        const lines = []
        const existingDetails = referenceLog[transaction.trn]?.[transaction.units];
        if (existingDetails) {
            lines.push(`🟥 ${entryToString({
                trn: transaction.trn,
                units: transaction.units,
                details: existingDetails
            })}`);
        }
        if (transaction.type === 'add') {
            lines.push(`🟩 ${entryToString(transaction)}`);
        }
        return lines;
    }).join('\n');
}