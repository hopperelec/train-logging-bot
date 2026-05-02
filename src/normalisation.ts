// This was complicated enough to warrant a dedicated file.

import {TRN} from "./types";

// --- TRN ---

const THREE_DIGIT_REGEX = new RegExp(/^t?\d{3}$/);
export function normalizeTRN(trn: TRN): TRN {
    return THREE_DIGIT_REGEX.test(trn) ? `T${trn.slice(-3)}` : trn;
}

// --- Description ---

// Formatting correction regexes
const METROCAR_FORMATTING_REGEX = new RegExp(/(?<!\d)(599|994|4) ?[0xX?]([\dx?]{2})(?!\d)/g);
const CLASS_555_FORMATTING_REGEX = new RegExp(/(?<!\d)(555|5) ?([\dxX?]{3})(?!\d)/g);

const NORMALIZED_METROCAR = "40[\\dxX?]{2}";
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
    "gi"
);

// Emojis
const UNKNOWN_UNIT_EMOJI = ":question:";
const METROCAR_EMOJI = "<:metrocar:1499879530695757934>";
const REGEX_TO_EMOJI: [RegExp, string][] = [
    [new RegExp(/^4001$/), "<:prototype_metrocar:1499880342243250377>"],
    [new RegExp(`^${NORMALIZED_METROCAR}$`), METROCAR_EMOJI],
    [new RegExp(/^5550[\dx?]{2}$/), "<:class555:1499879618239529020>"],
    [new RegExp(/^BL[123x]$/), "<:batteryloco:1499879926386397204>"],
    [new RegExp(/^MA[ -_]?60$/), "<:MA60:1499879986801283142>"],
];

// Main function

export function normalizeUnits(units: string) {
    units = units
        // Normalise formatting of individual metrocar units
        .replace(METROCAR_FORMATTING_REGEX, (_, __, unit) => `40${unit}`)
        // Normalise 555 units
        .replace(CLASS_555_FORMATTING_REGEX, (_, __, unit) => `555${unit}`)
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
        .replace(METROCAR_COUPLING_REGEX3, "+");

    const emojis = [];
    nextUnit: for (const unit of units.split("+")) {
        for (const [regex, emoji] of REGEX_TO_EMOJI) {
            if (regex.test(unit)) {
                emojis.push(emoji);
                continue nextUnit;
            }
        }
        // If we didn't find a match, consider the units malformed and don't add any emojis
        emojis.length = 0;
        break;
    }
    if (emojis.length > 0) {
        // If all units are metrocars, only add one emoji
        if (emojis.every(emoji => emoji === METROCAR_EMOJI)) {
            emojis.length = 1;
        }
        // If any unit is unknown, add the unknown unit emoji at the start
        if (units.includes("x") || units.includes("?")) {
            if (emojis.length > 1) {
                // If there are multiple unit emojis, add a space for readability
                emojis.unshift(" ");
            }
            emojis.unshift(UNKNOWN_UNIT_EMOJI);
        }
        return emojis.join("") + " " + units;
    }
    return units;
}
