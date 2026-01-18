# Tyne and Wear Metro train logging bot

This is the Discord bot developed for the [Metrowatch Discord server](https://discord.gg/KmBJznMyf4) for logging train allocations on the Tyne and Wear Metro network.

## 🔗 Table of contents
- [ℹ️ How it works](#how-it-works)
- [⚙️ Allocation fields](#allocation-fields)
- [✨ Natural language (AI) logging](#natural-language-ai-logging)
- [⌨️ Commands](#commands)
- [📝 Logging FAQs](#logging-faqs)
- [🏠 Hosting your own instance](#hosting-your-own-instance)

## ℹ️ How it works
- Every 3AM (or when the bot starts up), a new log is started.
- If a log channel is specified, an initial log message is posted in that channel. 
  - This message is edited throughout the day to reflect the current state of allocations.
  - If the message gets too long, yellow/green/other allocations are split into separate messages.
  - If one of those messages gets too long, those allocations are added as a file attachment instead.
- An allocation for a day is uniquely identified by a combination of its `trn` and its `units`. That means that a TRN can have multiple sets of units allocated to it, and a set of units can be allocated to multiple TRNs, but a set of units can not be allocated to a single TRN multiple times. An allocation can also include a number of other fields, which are detailed in the **⚙️ Allocation fields** section below.
- Users can submit allocations for today (or otherwise update today's log) by either:
    - Manually adding, updating or removing a single allocation using the `/log-allocation` and `/remove-allocation` commands
    - Providing an update (potentially involving multiple allocations) with natural language using the `/ai-log` command
    - Right-clicking a message containing information about today's allocations and clicking `Apps > Log with AI`
- If an approval channel is specified, then submissions by non-contributors get sent to the approval channel for manual approval before being added to the log.
- Otherwise or once approved, the entry is edited into the log message.
- Logs are persisted to a SQLite database of historic allocations, allowing users to search through past logs.
- If a transaction log channel is specified, a log of all changes made to the log ("transactions") is posted there, along with an undo button for each transaction.

## ⚙️ Allocation fields
- `trn` is a unique identifier for a service and, as the name implies, is usually the Train Running Number (e.g. "T123"). However, where the actual TRN isn't known, a short description (e.g. "Kilometre accumulation" or "Scrap move") can be used in its place.
- `units` is a list of units separated by `+`. For example, `4073+4081`. Where digits of a unit number are unknown, an `x` can be used in their place (e.g. an unknown metrocar set is `40xx+40xx`).
- `sources` is a list of people (or sometimes things) that can be used to verify all or parts of the allocation. This defaults to just the submitter if unspecified. If the source is a person in this server, they should be @ mentioned.
- `notes` is for any additional information about the allocation not already covered by the other fields. They should be concise and to the point.
  Examples: "withdrawn due to door fault", "graffiti tagged", "swapped from T101, then to T103", "4045 scrap move", "555046 delivery", "kilometre accumulation"
- `withdrawn` is a flag that states these units are no longer running on this TRN, including if they have swapped to another TRN.
- `index` is an integer used for ordering multiple allocations to the same TRN, where lower numbers come first. It defaults to 0. If an allocation is a real-world replacement for a previous allocation on the same TRN, it should have an index higher than that of the previous allocation.

## ✨ Natural language (AI) logging
When using the `/ai-log` slash command or `Log with AI` context menu command, the message is provided to a Large Language Model (LLM) similar to ChatGPT. To make sure the LLM understands the intent correctly, it might ask for clarification. Once it understands the intent, it will produce a sequence of "transactions" (additions or removals) to update the log corresponding to the query. The user will be asked to confirm its changes before they are submitted (to the approval channel if specified and the user is not a contributor). If the LLM made a mistake, the user can provide a correction.

I understand that generative AI is controversial, so I want to emphasize that:
- **for users:** AI has absolutely no involvement in changes made with `/log-allocation` or `/remove-allocation` and you are not obligated to use the AI features at all. Furthermore, no changes (whether manual or AI-assisted) will enter the log without first being approved by both you *and* one of our contributors.
- **for server owners:** the AI features are entirely optional and can be disabled by not providing any API keys

The following models and providers are supported. When multiple API keys are provided, they will be used in the order listed below, falling back to the next if one fails (e.g. due to rate limiting or quota exhaustion):
- Gemini 2.5 Flash
- gpt-oss-120b via Groq
- gpt-oss-120b via OpenRouter
- Gemini 2.5 Flash Lite
- Gemini 2.0 Flash
- gpt-oss-120b via NVIDIA NIM

The LLM is provided with a lot of context, instructions and examples to ensure it understands queries correctly. This is provided via its system prompt which you can view in [nlp-system-prompt.md](nlp-system-prompt.md).

## ⌨️ Commands

- `/log-allocation (trn) (units) [sources] [notes] [withdrawn] [index]` — Log one of today's allocations.
- `/remove-allocation (trn) (units)` — Remove an allocation from today's log.
- `/ai-log (prompt)` or context menu `Log with AI` — Amend the log using AI.
- `/search-trn (trn)` — Get the currently logged allocations for a given TRN.
- `/search-unit (query)` — Get all logged allocations containing the given unit.
- `/list-current-allocations` — Lists all non-withdrawn allocations logged for today.
- `/search-historic-allocations [date-from] [date-to] [limit] [trn] [units] [sources] [notes] [withdrawn]` — Search all allocations in the database (not just today) using a variety of filters.
- `/usage` — Sends a message explaining basic usage of the bot.

## 📝 Logging FAQs

### How do I edit the details (`sources`, `notes`, `withdrawn`, `index`) of an existing allocation?

Just log it again, the same way you would if it hadn't already been logged. You will be asked to confirm you want to remove the existing allocation.

### Some units have been logged on the wrong TRN. How can I correct it?

**Manually:** You will need to remove the incorrect allocation using `/remove-allocation` and add the corrected allocation using `/log-allocation`.

**Using natural language:** "555021 is actually on 104"

### Some units have been logged with missing digits (e.g. 4073+40xx). How can I complete it?

**Manually (option 1):** Remove the incomplete allocation using `/remove-allocation` and add the completed allocation using `/log-allocation`.

**Manually (option 2):** Use `/log-allocation` to log the completed allocation with the same `index`. The bot will warn you that an allocation with those `trn` and `index` already exists and provide a list of options for how to proceed. Select "Remove existing allocation(s)".

**Using natural language:** "73 is with 81" or "the missing unit on 122 is 4081"

### Some units have swapped from one TRN to another. How can I log that?

**Manually:** You can ignore the existing allocation and just log the new allocation using `/log-allocation`. Optionally, you can add a note to either or both allocations indicating the swap.

**Using natural language:** "T101 has swapped to T103"

## 🏠 Hosting your own instance

You are welcome to host your own instance of this bot. Below are instructions for doing so.

### Prerequisites
- [Node.js](https://nodejs.org/en/download/) v20.19.0+ or 22.12.0+
- [pnpm](https://pnpm.io/installation) v10.1.0+

### Create a Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and create a new application.
2. Under the "Bot" tab, create a new bot and copy its token to use later.
3. Set a bot icon and username as desired.
4. Under the "OAuth2" tab, go to "URL Generator" and select the `bot` and `applications.commands` scopes.
5. If you are using any of the optional features that involve posting messages to channels (log channel, approval channel, transaction log channel), select the following under "Bot Permissions":
   - View channels
   - Send Messages
   - Attach Files (so the bot can attach logs or transactions as files if they are too long)
   - Read Message History (so the bot can continue where it left off if it restarts)
   No other permissions are used, and [it is good practice to only grant the minimum permissions necessary](https://en.wikipedia.org/wiki/Principle_of_least_privilege). You can also leave all permissions unchecked and instead assign these permissions only to the log, approval and transaction channels directly in your server after inviting the bot.
6. Make sure "Integration Type" is set to "Guild Install".
7. Open the generated URL in your browser and invite the bot to your server.

### Get guild, channel and role IDs

To configure the bot, you may need to provide the IDs of certain channels, guilds, roles and emojis. To get these IDs:

1. In Discord, go to "User Settings" > "Advanced" and enable "Developer Mode".
2. Right-click the desired channel, guild, role or emoji and click "Copy ID".

### Environment variables

The bot is configured using the following environment variables. You can provide these in a file named `.env`. An example `.env.example` file is provided. Never share your `.env` file or its contents publicly.

**Required**
- `DISCORD_TOKEN`: The Discord bot token you copied earlier.

**Optional but recommended**
- `LOG_CHANNEL_ID`: The ID of the channel where daily log messages should be posted. If not provided, allocations will only be logged to the database
- `APPROVAL_CHANNEL_ID`: The ID of the channel where allocation submissions from non-contributors should be sent for approval. See below for behaviour if not provided.
- `TRANSACTION_CHANNEL_ID`: The ID of the channel where a log of all changes made to the log should be posted. If not provided, transactions will only be logged to the console.
- `CONTRIBUTOR_GUILD_ID`: The ID of the guild (server) where contributors have a specific role. Used in combination with `CONTRIBUTOR_ROLE_ID`.
- `CONTRIBUTOR_ROLE_ID`: The ID of the role that designates a user as a contributor. Users with this role can log allocations directly without needing approval and can approve submissions in the approval channel. See below for behaviour if not provided.

**API keys for LLM providers**
- `GOOGLE_AI_API_KEY`: API key for Google AI (Gemini) from [here](https://aistudio.google.com/api-keys)
- `OPENROUTER_API_KEY`: API key for OpenRouter from [here](https://openrouter.ai/settings/keys)
- `NVIDIA_NIM_API_KEY`: API key for NVIDIA NIM from [here](https://build.nvidia.com/settings/api-keys)
- `GROQ_API_KEY`: API key for Groq from [here](https://console.groq.com/keys)

Behaviour if approval channel and/or contributor role are not provided:
- If neither `APPROVAL_CHANNEL_ID` nor `CONTRIBUTOR_ROLE_ID` are provided, all submissions will be applied directly to the log without approval.
- If `APPROVAL_CHANNEL_ID` is provided but `CONTRIBUTOR_ROLE_ID` is not, all submissions will first go to the approval channel, but anyone with access to that channel can approve them.
- If `APPROVAL_CHANNEL_ID` is not provided but `CONTRIBUTOR_ROLE_ID` is, only contributors will be able to make changes to the log.

### Installation

You will need a server (a physical one, not just a Discord server) to host the bot on. The bot will only work while this server is running and connected to the internet, so you probably don't want to run it on your personal computer unless you plan to keep it on 24/7. From the terminal on your server, follow these steps:

1. Clone this repository
   ```bash
   git clone https://github.com/hopperelec/train-logging-bot
   cd train-logging-bot
   ```
2. Install dependencies
   ```bash
    pnpm i
   ```
3. Create your `.env` file if you haven't already
   ```bash
   cp .env.example .env
   ```
   Then edit `.env` to add your configuration.
4. Initialize the database
   ```bash
   pnpm prisma:deploy
   ```
5. Edit `/usage` message in `src/bot.ts` (search for "**About this bot**" - it is currently hardcoded for Metrowatch) to suit your server.
6. Edit the emojis prepended to metrocars and Class 555 units in `src/normalization.ts` (search for `:metrocar:` and `:class555:` - these are currently hardcoded for Metrowatch) to suit your server. You will need the IDs of the custom emojis you want to use.
7. Start the bot
   ```bash
   pnpm start
   ```
   
### Updating

To update to the latest version:
1. Pull the latest changes from the repository
   ```bash
   git pull
   ```
   If there are any merge conflicts (e.g. if you modified any files), you can either try to resolve them manually, or you can discard your local changes and reset to the latest version from the repository
   ```bash
   git reset --hard origin/main
   ```
   If you reset, you will need to re-apply any customizations you made (e.g. step 5 and 6 from the installation instructions).
2. Update dependencies
   ```bash
   pnpm i
   ```
3. Update the database schema
   ```bash
   pnpm prisma:deploy
   ```
