// This was complicated enough to warrant a dedicated file.

import {TRN} from "./types";

// --- TRN ---

const THREE_DIGIT_REGEX = new RegExp(/^t?\d{3}$/);
export function normalizeTRN(trn: TRN): TRN {
    return THREE_DIGIT_REGEX.test(trn) ? `T${trn.slice(-3)}` : trn;
}

// --- Description ---

const CLASS_555_FORMATTING_REGEX = new RegExp(/(?<!\d)(555|5) ?((\d|\?|x){3})(?!\d)/g);
const METROCAR_FORMATTING_REGEX = new RegExp(/(?<!\d)(599|994|4) ?[0x?]((\d|\?|x){2})(?!\d)/g);

const NORMALIZED_METROCAR = "40(\\d|\\?|x){2}";
const METROCAR_COUPLING_REGEX1 = new RegExp(`${NORMALIZED_METROCAR}( ${NORMALIZED_METROCAR})+`, "g");
const METROCAR_COUPLING_REGEX2 = new RegExp(
    "(?<!\\+|\\d)" + // Not preceded by a + or digit
    NORMALIZED_METROCAR + // At least one metrocar
    `( \\+ ${NORMALIZED_METROCAR})+` + // Followed by one or more metrocars separated by " + "
    "(?!\\+|\\d)", // Not followed by a + or digit
    "g"
);
const METROCAR_COUPLING_REGEX3 = new RegExp(
    "(?<=" + // Don't include first unit in match
    "(?<!\\+|\\d)" + // Not preceded by a + or digit
    NORMALIZED_METROCAR + // Preceded by a metrocar
    ")" +
    "( and | & | - |-| / |/| \\\\ |\\\\)" + // This is the only part included in the match
    "(?=" + // Don't include second unit in match
    NORMALIZED_METROCAR + // Followed by a metrocar
    "(?!\\+|\\d)" + // Not followed by a + or digit
    ")",
    "g"
);

const DISCORD_EMOJI_FORMAT = "<a?:\\w+:\\d+> ?";
const CLASS_555_EMOJI_REGEX = new RegExp(
    `(?<!\\d|${DISCORD_EMOJI_FORMAT})` + // Not preceded by a digit or an existing emoji
    "555\\d(\\d|\\?|x){2}" + // This is the only part included in the match
    "(?!\\d|x)", // Not followed by a digit or x
    "g"
);
const METROCAR_EMOJI_REGEX = new RegExp(
    `(?<!\\+|\\d|${DISCORD_EMOJI_FORMAT})` + // Not preceded by a +, digit, or an existing emoji
    NORMALIZED_METROCAR + // At least one metrocar
    `(\\+${NORMALIZED_METROCAR})*` + // Followed by one or more metrocars separated by "+"
    "(?!\\+|\\d)", // Not followed by a + or digit
    "g"
);

function addEmojis(unitEmoji: string) {
    // Prepends unitEmoji and, if the unit contains 'x', a question mark emoji
    return (unit: string) => unit.includes('x') ? `:question:<${unitEmoji}> ${unit}` : `<${unitEmoji}> ${unit}`;
}

export function normalizeDescription(description: string) {
    return description
        // Normalize 555 units
        .replace(CLASS_555_FORMATTING_REGEX, (_, __, unit) => `555${unit}`)
        // Normalize formatting of individual metrocar units
        .replace(METROCAR_FORMATTING_REGEX, (_, __, unit) => `40${unit}`)
        // Replace "40xx 40xx" with "40xx+40xx"
        .replace(METROCAR_COUPLING_REGEX1, match => match.replaceAll(" ", "+"))
        // Replace "40xx + 40xx" with "40xx+40xx"
        .replace(METROCAR_COUPLING_REGEX2, match => match.replaceAll(" ", ""))
        // Replace all the following with "40xx+40xx":
        // - 40xx and 40xx
        // - 40xx & 40xx
        // - 40xx - 40xx
        // - 40xx-40xx
        // - 40xx / 40xx
        // - 40xx/40xx
        // - 40xx \ 40xx
        // - 40xx\40xx
        .replace(METROCAR_COUPLING_REGEX3, "+")
        // Add emojis to class 555 units
        .replace(CLASS_555_EMOJI_REGEX, addEmojis(':class555:1358573606665195558'))
        // Add emojis to metrocar sets
        .replace(METROCAR_EMOJI_REGEX, addEmojis(':metrocar:1332544654847115354'))
}
