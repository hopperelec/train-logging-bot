// This was complicated enough to warrant a dedicated file.

import {TRN} from "./types";

// --- TRN ---

const THREE_DIGIT_REGEX = new RegExp(/^t?\d{3}$/);
export function normalizeTRN(trn: TRN): TRN {
    return THREE_DIGIT_REGEX.test(trn) ? `T${trn.slice(-3)}` : trn;
}

// --- Description ---

const CLASS_555_FORMATTING_REGEX = new RegExp(/(?<!\d)(555|5) ?((\d|\?|x){3})(?!\d)/gi);
const METROCAR_FORMATTING_REGEX = new RegExp(/(?<!\d)(599|994|4) ?[0x?]((\d|\?|x){2})(?!\d)/gi);

const NORMALIZED_METROCAR = "40(\\d|\\?|x){2}";
const METROCAR_COUPLING_REGEX1 = new RegExp(`${NORMALIZED_METROCAR}( ${NORMALIZED_METROCAR})+`, "gi");
const METROCAR_COUPLING_REGEX2 = new RegExp(
    "(?<!\\+|\\d)" + // Not preceded by a + or digit
    NORMALIZED_METROCAR + // At least one metrocar
    `( \\+ ${NORMALIZED_METROCAR})+` + // Followed by one or more metrocars separated by " + "
    "(?!\\+|\\d)", // Not followed by a + or digit
    "gi"
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
    "gi"
);

const DISCORD_EMOJI_FORMAT = "<a?:\\w+:\\d+> ?";
const CLASS_555_EMOJI_REGEX = new RegExp(
    `(?<!\\d|${DISCORD_EMOJI_FORMAT})` + // Not preceded by a digit or an existing emoji
    "555\\d(\\d|\\?|x){2}" + // This is the only part included in the match
    "(?!\\d|x)", // Not followed by a digit or x
    "gi"
);
const METROCAR_EMOJI_REGEX = new RegExp(
    `(?<!\\+|\\d|${DISCORD_EMOJI_FORMAT})` + // Not preceded by a +, digit, or an existing emoji
    NORMALIZED_METROCAR + // At least one metrocar
    `(\\+${NORMALIZED_METROCAR})*` + // Followed by one or more metrocars separated by "+"
    "(?!\\+|\\d)", // Not followed by a + or digit
    "gi"
);

const UNKNOWN_UNIT_REGEX = new RegExp(/([x?])/gi);

function addEmojis(unitEmoji: string) {
    // Prepends unitEmoji and, if the unit contains 'x', a question mark emoji
    return (unit: string) => UNKNOWN_UNIT_REGEX.test(unit)
        ? `:question:<${unitEmoji}> ${unit.replaceAll(UNKNOWN_UNIT_REGEX, 'x')}`
        : `<${unitEmoji}> ${unit}`;
}

export function normalizeUnits(units: string) {
    return units
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
