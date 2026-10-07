// These are in their own file (rather than bot.ts) so that other modules can use them without importing bot.ts,
// which would start the bot

export const CONTENT_CHARACTER_LIMIT = 2000; // Discord message content character limit
export const EMBED_DESCRIPTION_CHARACTER_LIMIT = 4096; // Discord embed description character limit
export const EMBED_FIELD_CHARACTER_LIMIT = 1024; // Discord embed field value character limit
export const AUTOCOMPLETE_CHOICE_CHARACTER_LIMIT = 100; // Discord autocomplete choice name/value character limit
export const NEW_DAY_HOUR = 3;
