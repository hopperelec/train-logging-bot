import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../generated/prisma/client";
import {DailyLog, LogTransaction} from "./types";
import {NEW_DAY_HOUR} from "./bot";

let todaysLog: DailyLog = {};
let dayId: number;

const prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: 'file:./train-logs.db' })
});

// Returns any existing message IDs
export async function loadTodaysLog(): Promise<string[]> {
    todaysLog = {};

    const date = new Date();
    if (date.getHours() < NEW_DAY_HOUR) {
        date.setDate(date.getDate() - 1);
    }
    date.setHours(NEW_DAY_HOUR, 0, 0, 0);
    const dateStr = date.toISOString().split('T')[0];

    const existingDay = await prisma.day.findUnique({
        where: { date: date },
        include: {
            messages: true,
            allocations: true,
        },
    });
    if (existingDay) {
        dayId = existingDay.id;
        for (const allocation of existingDay.allocations) {
            if (!todaysLog[allocation.trn]) {
                todaysLog[allocation.trn] = {};
            }
            todaysLog[allocation.trn][allocation.units] = {
                sources: allocation.sources,
                notes: allocation.notes || undefined,
                index: allocation.index || undefined,
                withdrawn: allocation.withdrawn || undefined,
            };
        }
        console.log(`Loaded existing log for ${dateStr}`);
        return existingDay.messages.map(m => m.id);
    }

    const result = await prisma.day.create({
        data: {date: date},
    });
    dayId = result.id
    console.log(`Started new log for ${dateStr}`);
    return [];
}

export function getTodaysLog(): DailyLog {
    return structuredClone(todaysLog);
}

export async function removeMessage(message: {id: string}) {
    await prisma.message.delete({
        where: { id: message.id },
    });
}

export async function addMessage(message: {id: string}) {
    await prisma.message.create({
        data: {
            id: message.id,
            dayId: dayId,
        },
    });
}

export function getAllocation(trn: string, units: string) {
    return structuredClone(todaysLog[trn]?.[units]);
}

export async function runTransactions(transactions: LogTransaction[]) {
    await prisma.$transaction([
        // Delete *all* affected allocations, so that additions will replace any existing ones
        prisma.allocation.deleteMany({
            where: {
                dayId: dayId,
                AND: transactions.map(allocation => ({
                    trn: allocation.trn,
                    units: allocation.units,
                })),
            },
        }),
        // Then add (or re-add if it's an update) the added allocations
        prisma.allocation.createMany({
            data: transactions.filter(t => t.type === 'add').map(allocation => ({
                dayId: dayId,
                trn: allocation.trn,
                units: allocation.units,
                ...allocation.details,
            }))
        }),
    ]);
    for (const transaction of transactions) {
        if (transaction.type === 'add') {
            if (!todaysLog[transaction.trn]) {
                todaysLog[transaction.trn] = {};
            }
            todaysLog[transaction.trn][transaction.units] = transaction.details;
        } else if (transaction.type === 'remove') {
            if (todaysLog[transaction.trn]?.[transaction.units]) {
                delete todaysLog[transaction.trn][transaction.units];
                if (Object.keys(todaysLog[transaction.trn]).length === 0) {
                    delete todaysLog[transaction.trn];
                }
            }
        }
    }
}
