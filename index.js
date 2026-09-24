const http = require("http");
const {
Client,
GatewayIntentBits,
REST,
Routes,
SlashCommandBuilder,
PermissionFlagsBits,
AttachmentBuilder,
ActionRowBuilder,
StringSelectMenuBuilder,
StringSelectMenuOptionBuilder,
ButtonBuilder,
ButtonStyle,
ModalBuilder,
TextInputBuilder,
TextInputStyle,
MessageFlags,
ContainerBuilder,
TextDisplayBuilder,
ChannelType,
} = require("discord.js");
const sharp = require("sharp");
const TOKEN = process.env.DISCORD_TOKEN;
const POLL_DATA_CHANNEL_ID = process.env.POLL_DATA_CHANNEL_ID;
// Optional: set this to your server's ID for instant command updates
// while testing. Global commands (no GUILD_ID set) can take up to an
// hour for Discord to propagate to every client.
const GUILD_ID = process.env.GUILD_ID;
const PORT = process.env.PORT || 3000;
/*
* Each character gets its OWN image (not one giant
* stitched image). Discord displays multiple attachments
* in a message as a grid, and each one renders much
* larger than a slice of one super-wide image would.
*/
// Number of characters/pictures in a poll (each gets one image) and
// number of voting categories (each character is assigned one of these).
// These are independent of each other.
const CHARACTER_COUNT = 4;
const CATEGORY_COUNT = 4;
const PHOTO_WIDTH = 700;
const PHOTO_HEIGHT = 1050;
const BADGE_HEIGHT = 120; // top: winning category name
const SYMBOL_BAR_HEIGHT = 140; // bottom: symbols + counts
const SYMBOL_ICON_SIZE = 56;
const TWEMOJI_BASE = "https://raw.githubusercontent.com/jdecked/twemoji/main/assets/72x72/";
const SCHEMA_VERSION = 6;
const client = new Client({
intents: [GatewayIntentBits.Guilds],
});
let poll = null;
let votes = new Map();
let selections = new Map();
let publicPollMessage = null;
let stateMessageId = null;
let closeTimer = null;
// Setup data captured from the /poll command while the
// category modal is being filled in.
const pendingSetups = new Map();
// Guards against the same interaction being handled twice
// if this process somehow receives the event more than once
// (e.g. a brief overlap between two running instances).
const processingInteractions = new Set();
function makeId() {
return `${Date.now()}-${Math.floor(Math.random() * 1000000000)}`;
}
function clean(value) {
return String(value || "").trim();
}
function cleanSymbol(value) {
const text = clean(value);
const markdown = text.match(/^\[([^\]]+)\]\([^)]+\)$/);
return markdown ? markdown[1] : text;
}
function truncate(value, max) {
const text = clean(value);
return text.length > max ? text.slice(0, max - 1) + "…" : text;
}
function escapeSvg(value) {
return String(value)
.replace(/&/g, "&amp;")
.replace(/</g, "&lt;")
.replace(/>/g, "&gt;")
.replace(/"/g, "&quot;")
.replace(/'/g, "&apos;");
}
function textSize(text, width) {
const length = text.length;
if (length <= 12) return Math.min(26, width / 8);
if (length <= 20) return Math.min(21, width / 10);
if (length <= 30) return Math.min(17, width / 12);
return Math.min(14, width / 15);
}
async function downloadBuffer(url) {
// A hard timeout so a stalled network request can never hang poll
// creation indefinitely.
const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
if (!response.ok) {
throw new Error(`Image download failed: ${response.status}`);
}
return Buffer.from(await response.arrayBuffer());
}
/*
 * SYMBOL IMAGES
 *
 * Emoji rendered as *text* inside an SVG depends on whatever font
 * happens to be installed on the server, which is unreliable on
 * Render (missing glyphs fall back to the wrong character). To make
 * symbols always render correctly, each one is resolved to a real
 * PNG image instead: a Twemoji asset for standard emoji, or the
 * Discord CDN image for a custom server emoji.
 */
function toCodepointHex(str) {
  return Array.from(str)
    .map((char) => char.codePointAt(0).toString(16))
    .join("-");
}

function parseCustomEmojiId(text) {
  const match = clean(text).match(/^<a?:\w+:(\d+)>$/);
  return match ? match[1] : null;
}

async function fetchSymbolImage(rawSymbol) {
  const symbol = cleanSymbol(rawSymbol);
  const customEmojiId = parseCustomEmojiId(symbol);
  if (customEmojiId) {
    try {
      return await downloadBuffer(`https://cdn.discordapp.com/emojis/${customEmojiId}.png?size=96`);
    } catch (error) {
      console.error(`Custom emoji ${customEmojiId} failed to download:`, error.message);
      return null;
    }
  }
  const withSelector = toCodepointHex(symbol);
  try {
    return await downloadBuffer(`${TWEMOJI_BASE}${withSelector}.png`);
  } catch {}
  // Many twemoji filenames omit the variation-selector codepoint (fe0f) —
  // retry without it before giving up.
  const stripped = Array.from(symbol)
    .filter((char) => char.codePointAt(0) !== 0xfe0f)
    .map((char) => char.codePointAt(0).toString(16))
    .join("-");
  if (stripped && stripped !== withSelector) {
    try {
      return await downloadBuffer(`${TWEMOJI_BASE}${stripped}.png`);
    } catch {}
  }
  console.error(`No emoji image found for symbol: ${symbol}`);
  return null;
}

// Cached across the whole process, not just one poll, so re-using the
// same emoji (e.g. \ud83d\udd25 in several polls) never needs a second fetch.
const symbolImageCache = new Map();
async function buildSymbolImages(symbols) {
  const images = [];
  for (const symbol of symbols) {
    const key = cleanSymbol(symbol);
    if (symbolImageCache.has(key)) {
      images.push(symbolImageCache.get(key));
      continue;
    }
    const buffer = await fetchSymbolImage(symbol);
    let processed = null;
    if (buffer) {
      try {
        processed = await sharp(buffer)
          .resize(SYMBOL_ICON_SIZE, SYMBOL_ICON_SIZE, { fit: "contain" })
          .png()
          .toBuffer();
      } catch (error) {
        console.error("Could not process symbol image:", error.message);
      }
    }
    symbolImageCache.set(key, processed);
    images.push(processed);
  }
  return images;
}

async function getDataChannel() {
return await client.channels.fetch(POLL_DATA_CHANNEL_ID);
}
async function getAllDataMessages() {
const channel = await getDataChannel();
const messages = [];
let before;
while (true) {
const batch = await channel.messages.fetch({ limit: 100, before });
if (!batch.size) break;
messages.push(...batch.values());
if (batch.size < 100) break;
before = batch.last().id;
}
return messages;
}
/*
* VOTE TALLYING
*
* counts[option][character] = how many people picked
* that category for that character.
*/
function getCounts() {
const counts = Array.from({ length: CATEGORY_COUNT }, () => Array(CHARACTER_COUNT).fill(0));
for (const vote of votes.values()) {
if (!vote.choices) continue;
for (let character = 0; character < CHARACTER_COUNT; character++) {
const option = vote.choices[character];
if (option >= 0 && option < CATEGORY_COUNT) {
counts[option][character]++;
}
}
}
return counts;
}
function getCharacterLeaders(counts) {
const leaders = [];
for (let character = 0; character < CHARACTER_COUNT; character++) {
let highest = 0;
const winningOptions = [];
for (let option = 0; option < CATEGORY_COUNT; option++) {
const count = counts[option][character];
if (count > highest) {
highest = count;
winningOptions.length = 0;
winningOptions.push(option);
} else if (count > 0 && count === highest) {
winningOptions.push(option);
}
}
leaders.push(winningOptions);
}
return leaders;
}
/*
* IMAGE BUILDING
*
* Each character gets one tall image:
* [ winning category badge(s) ]
* [ photo ]
* [ symbols + vote counts ]
*/
function buildResultOverlaySvg(characterIndex, counts, leaders) {
const width = PHOTO_WIDTH;
const height = BADGE_HEIGHT + PHOTO_HEIGHT + SYMBOL_BAR_HEIGHT;
const winningOptions = leaders[characterIndex] || [];
let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`;
// Top badge area
svg += `<rect x="0" y="0" width="${width}" height="${BADGE_HEIGHT}" fill="#111111"/>`;
if (winningOptions.length) {
const gap = 8;
const badgeWidth =
(width - 20 - gap * (winningOptions.length - 1)) / winningOptions.length;
winningOptions.forEach((option, index) => {
const x = 10 + index * (badgeWidth + gap);
const label = poll.resultLabels[option];
const count = counts[option][characterIndex];
const labelWithCount = `${label} (${count})`;
const fontSize = textSize(labelWithCount, badgeWidth);
svg += `
<rect x="${x}" y="14" width="${badgeWidth}" height="${BADGE_HEIGHT - 28}"
rx="16" fill="#242424" stroke="#ffffff" stroke-width="2"/>
<text x="${x + badgeWidth / 2}" y="${BADGE_HEIGHT / 2}"
text-anchor="middle" dominant-baseline="middle" fill="white"
font-family="Arial, sans-serif" font-size="${fontSize}px" font-weight="700">
${escapeSvg(truncate(labelWithCount, 35))}
</text>
`;
});
} else {
svg += `
<text x="${width / 2}" y="${BADGE_HEIGHT / 2}" text-anchor="middle"
dominant-baseline="middle" fill="#777777" font-family="Arial, sans-serif"
font-size="20px">
No votes yet
</text>
`;
}
// Bottom symbol bar — this character's votes per category
const barY = BADGE_HEIGHT + PHOTO_HEIGHT;
svg += `<rect x="0" y="${barY}" width="${width}" height="${SYMBOL_BAR_HEIGHT}" fill="#111111"/>`;
const cellWidth = width / CATEGORY_COUNT;
for (let option = 0; option < CATEGORY_COUNT; option++) {
const count = counts[option][characterIndex];
const centerX = cellWidth * option + cellWidth / 2;
// The symbol itself is drawn separately as a real image (see
// buildCharacterResultImage) — text-based emoji rendering is
// unreliable on headless servers. This just draws the count,
// positioned below where that image sits.
svg += `
<text x="${centerX}" y="${barY + SYMBOL_BAR_HEIGHT / 2 + 34}"
text-anchor="middle" dominant-baseline="middle" fill="white"
font-family="Arial, sans-serif" font-size="26px" font-weight="700">
${count}
</text>
`;
}
svg += "</svg>";
return Buffer.from(svg);
}
async function buildCharacterResultImage(characterIndex, counts, leaders) {
const overlay = buildResultOverlaySvg(characterIndex, counts, leaders);
const height = BADGE_HEIGHT + PHOTO_HEIGHT + SYMBOL_BAR_HEIGHT;
const barY = BADGE_HEIGHT + PHOTO_HEIGHT;
const cellWidth = PHOTO_WIDTH / CATEGORY_COUNT;
const composites = [
{ input: poll.photos[characterIndex], top: BADGE_HEIGHT, left: 0 },
{ input: overlay, top: 0, left: 0 },
];
for (let option = 0; option < CATEGORY_COUNT; option++) {
const icon = poll.symbolImages && poll.symbolImages[option];
if (!icon) continue;
const centerX = cellWidth * option + cellWidth / 2;
composites.push({
input: icon,
top: Math.round(barY + 14),
left: Math.round(centerX - SYMBOL_ICON_SIZE / 2),
});
}
return await sharp({
create: {
width: PHOTO_WIDTH,
height,
channels: 3,
background: "#111111",
},
})
.composite(composites)
.jpeg({ quality: 92 })
.toBuffer();
}
// All characters are stitched into ONE image and sent as a single
// attachment, arranged as a neat 2-wide grid, rather than sent as
// separate attachments — Discord's own client auto-arranges multiple
// attachments into its own grid (shrinking each one further to fit),
// which is what used to split/duplicate the poll unpredictably. Also,
// Discord caps how wide it will ever display an attached image in a
// message regardless of the file's actual resolution, so a single
// long row of panels always renders tiny — a 2-wide grid instead
// means each panel gets a much bigger share of that same fixed width.
async function buildCombinedResultImage() {
const counts = getCounts();
const leaders = getCharacterLeaders(counts);
poll.characterLeaders = leaders;
const panels = [];
for (let i = 0; i < CHARACTER_COUNT; i++) {
panels.push(await buildCharacterResultImage(i, counts, leaders));
}
const panelHeight = BADGE_HEIGHT + PHOTO_HEIGHT + SYMBOL_BAR_HEIGHT;
const COLUMNS = 2;
const rowCount = Math.ceil(panels.length / COLUMNS);
const canvasWidth = PHOTO_WIDTH * COLUMNS;
const composites = panels.map((buffer, index) => {
const row = Math.floor(index / COLUMNS);
const col = index % COLUMNS;
const panelsInThisRow = Math.min(COLUMNS, panels.length - row * COLUMNS);
const rowOffset = (canvasWidth - PHOTO_WIDTH * panelsInThisRow) / 2;
return {
input: buffer,
left: Math.round(rowOffset + col * PHOTO_WIDTH),
top: row * panelHeight,
};
});
return await sharp({
create: {
width: canvasWidth,
height: panelHeight * rowCount,
channels: 3,
background: "#111111",
},
})
.composite(composites)
.jpeg({ quality: 90 })
.toBuffer();
}
/*
* PERSISTENCE
*/
async function saveBaseImages() {
const channel = await getDataChannel();
const attachments = poll.photos.map(
(buffer, index) =>
new AttachmentBuilder(buffer, { name: `base-${index}.jpg` })
);
const message = await channel.send({
content: `POLL_BASE|${poll.id}`,
files: attachments,
});
poll.baseImageMessageId = message.id;
}
async function saveVote(userId, choices) {
const channel = await getDataChannel();
await channel.send(
`VOTE|${JSON.stringify({
pollId: poll.id,
userId,
choices,
timestamp: Date.now(),
})}`
);
}
async function saveState() {
if (!poll) return;
const channel = await getDataChannel();
if (stateMessageId) {
try {
const old = await channel.messages.fetch(stateMessageId);
await old.delete();
} catch {}
}
const state = {
schemaVersion: SCHEMA_VERSION,
pollId: poll.id,
duration: poll.duration,
startTime: poll.startTime,
endTime: poll.endTime,
publicChannelId: poll.publicChannelId,
publicMessageId: poll.publicMessageId,
baseImageMessageId: poll.baseImageMessageId,
characters: poll.characters.map((character) => ({ name: character.name })),
voteLabels: poll.voteLabels,
symbols: poll.symbols,
resultLabels: poll.resultLabels,
characterLeaders: poll.characterLeaders,
status: poll.status,
};
const message = await channel.send(`POLL_STATE|${JSON.stringify(state)}`);
stateMessageId = message.id;
}
/*
* PUBLIC MESSAGE
*
* Just the 4 photos + one "Vote / Change Vote" button.
*/
function buildVoteButtonRow(disabled = false) {
return new ActionRowBuilder().addComponents(
new ButtonBuilder()
.setCustomId("vote")
.setLabel(disabled ? "Poll closed" : "Vote / Change Vote")
.setStyle(disabled ? ButtonStyle.Secondary : ButtonStyle.Success)
.setDisabled(disabled)
);
}
async function updatePublicImage() {
if (!poll || !publicPollMessage) return;
const combined = await buildCombinedResultImage();
await publicPollMessage.edit({
content: poll.status === "active" ? null : "?? Poll closed — thanks for voting!",
attachments: [],
files: [new AttachmentBuilder(combined, { name: "poll-results.jpg" })],
components: [buildVoteButtonRow(poll.status !== "active")],
});
}
/*
* PRIVATE VOTE PANEL
*
* All 4 dropdowns shown together, one per character, plus a
* Confirm Vote button. Nothing is saved until Confirm is pressed
* (and the button stays disabled until all 4 are picked). Built
* with Components V2 so the dropdowns + button + status text can
* all sit in one panel — classic components cap out at 5 action
* rows total, which would leave no room for a Confirm button
* alongside 5 dropdowns, though with 4 there's exactly enough room.
*/
function buildCategorySelectRow(userId, characterIndex) {
const current = selections.get(userId) || Array(CHARACTER_COUNT).fill(null);
const currentChoice = current[characterIndex];
const usedByOthers = new Set(
current.filter((value, index) => value !== null && index !== characterIndex)
);
const available = poll.voteLabels
.map((label, optionIndex) => ({ label, optionIndex }))
.filter(
({ optionIndex }) => !usedByOthers.has(optionIndex) || optionIndex === currentChoice
);
const characterName = poll.characters[characterIndex].name;
const menu = new StringSelectMenuBuilder()
.setCustomId(`choice:${characterIndex}`)
.setPlaceholder(
currentChoice === null
? `${truncate(characterName, 40)} — choose a category`
: `${truncate(characterName, 30)} — ${truncate(poll.voteLabels[currentChoice], 40)}`
)
.addOptions(
available.map(
({ label, optionIndex }) =>
new StringSelectMenuOptionBuilder()
.setLabel(truncate(label, 100))
.setValue(String(optionIndex))
.setDefault(currentChoice === optionIndex)
)
);
return new ActionRowBuilder().addComponents(menu);
}
function assignedCount(userId) {
const current = selections.get(userId) || Array(CHARACTER_COUNT).fill(null);
return current.filter((value) => value !== null).length;
}
function buildConfirmRow(userId) {
const assigned = assignedCount(userId);
return new ActionRowBuilder().addComponents(
new ButtonBuilder()
.setCustomId("confirm-vote")
.setLabel(assigned === CHARACTER_COUNT ? "Confirm Vote ✅" : `Confirm Vote (${assigned}/${CHARACTER_COUNT} picked)`)
.setStyle(ButtonStyle.Success)
.setDisabled(assigned !== CHARACTER_COUNT)
);
}
function statusTextFor(userId, extra) {
if (extra) return extra;
const assigned = assignedCount(userId);
if (assigned === CHARACTER_COUNT) {
return "All four picked. Press **Confirm Vote** below to lock it in — you can still change any dropdown first.";
}
return `Pick one category per character. **${assigned}/${CHARACTER_COUNT}** chosen so far.`;
}
function buildVotePanel(userId, statusMessage) {
const container = new ContainerBuilder().addTextDisplayComponents(
new TextDisplayBuilder().setContent(statusTextFor(userId, statusMessage))
);
for (let index = 0; index < CHARACTER_COUNT; index++) {
container.addActionRowComponents(buildCategorySelectRow(userId, index));
}
container.addActionRowComponents(buildConfirmRow(userId));
return {
components: [container],
flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
};
}
async function openVote(interaction) {
if (!poll || poll.status !== "active") {
return interaction.reply({
content: "This poll is closed.",
flags: MessageFlags.Ephemeral,
});
}
if (!selections.has(interaction.user.id)) {
const previous = votes.get(interaction.user.id);
selections.set(
interaction.user.id,
previous ? [...previous.choices] : Array(CHARACTER_COUNT).fill(null)
);
}
return interaction.reply(buildVotePanel(interaction.user.id));
}
async function handleChoice(interaction) {
if (!poll || poll.status !== "active") {
return interaction.reply({
content: "This poll is closed.",
flags: MessageFlags.Ephemeral,
});
}
const characterIndex = Number(interaction.customId.split(":")[1]);
const optionIndex = Number(interaction.values[0]);
if (
characterIndex < 0 ||
characterIndex >= CHARACTER_COUNT ||
optionIndex < 0 ||
optionIndex >= CATEGORY_COUNT
) {
return interaction.reply({
content: "Invalid selection.",
flags: MessageFlags.Ephemeral,
});
}
const current = selections.get(interaction.user.id) || Array(CHARACTER_COUNT).fill(null);
for (let index = 0; index < CHARACTER_COUNT; index++) {
if (index !== characterIndex && current[index] === optionIndex) {
return interaction.reply({
content: "That category is already assigned to another character.",
flags: MessageFlags.Ephemeral,
});
}
}
current[characterIndex] = optionIndex;
selections.set(interaction.user.id, [...current]);
await interaction.update(buildVotePanel(interaction.user.id));
}
async function confirmVote(interaction) {
if (!poll || poll.status !== "active") {
return interaction.reply({
content: "This poll is closed.",
flags: MessageFlags.Ephemeral,
});
}
const current = selections.get(interaction.user.id) || Array(CHARACTER_COUNT).fill(null);
if (assignedCount(interaction.user.id) !== CHARACTER_COUNT) {
return interaction.reply({
content: "Pick a category for all four characters before confirming.",
flags: MessageFlags.Ephemeral,
});
}
votes.set(interaction.user.id, {
choices: [...current],
timestamp: Date.now(),
});
// Acknowledge within Discord's 3-second window FIRST — updatePublicImage()
// rebuilds the combined result image, which is too slow to finish before
// that window closes if done beforehand (this was causing "didn't
// respond in time" on Confirm Vote).
await interaction.deferUpdate();
await saveVote(interaction.user.id, current);
await updatePublicImage();
await saveState();
const panel = buildVotePanel(
interaction.user.id,
"✅ **Vote submitted!** Reopen with the Vote button anytime to change it before the poll closes."
);
await interaction.editReply(panel);
}
/*
* CLOSE / SCHEDULE
*/
async function closePoll() {
if (!poll) return;
poll.status = "closed";
if (closeTimer) {
clearTimeout(closeTimer);
closeTimer = null;
}
try {
await updatePublicImage();
} catch (error) {
console.error("Could not update closed poll:", error);
}
await saveState();
selections.clear();
}
function scheduleClose() {
if (!poll) return;
if (closeTimer) clearTimeout(closeTimer);
const remaining = poll.endTime - Date.now();
if (remaining <= 0) {
return closePoll();
}
closeTimer = setTimeout(closePoll, remaining);
}
/*
* RESTORE AFTER RESTART
*/
async function loadSavedPoll() {
const messages = await getAllDataMessages();
const stateMessages = messages
.filter((message) => message.content.startsWith("POLL_STATE|"))
.sort((a, b) => b.createdTimestamp - a.createdTimestamp);
if (!stateMessages.length) return;
let saved;
try {
saved = JSON.parse(stateMessages[0].content.substring("POLL_STATE|".length));
} catch {
return;
}
if (saved.schemaVersion !== SCHEMA_VERSION) return;
if (saved.status !== "active") return;
if (saved.endTime <= Date.now()) return;
poll = { ...saved, characters: saved.characters.map((c) => ({ name: c.name })) };
stateMessageId = stateMessages[0].id;
const dataChannel = await getDataChannel();
try {
const baseMessage = await dataChannel.messages.fetch(saved.baseImageMessageId);
const attachments = [...baseMessage.attachments.values()].sort((a, b) =>
a.name.localeCompare(b.name)
);
if (attachments.length !== CHARACTER_COUNT) {
throw new Error(`Expected ${CHARACTER_COUNT} base images.`);
}
poll.photos = await Promise.all(attachments.map((a) => downloadBuffer(a.url)));
} catch (error) {
console.error("Could not restore base images:", error);
poll = null;
return;
}
// Symbol images aren't persisted (they're cheap to re-fetch from
// Twemoji/Discord's CDN), so rebuild them from the saved symbols.
poll.symbolImages = await buildSymbolImages(saved.symbols);
const publicChannel = await client.channels.fetch(saved.publicChannelId);
try {
publicPollMessage = await publicChannel.messages.fetch(saved.publicMessageId);
} catch {
poll = null;
return;
}
votes = new Map();
for (const message of messages) {
if (!message.content.startsWith("VOTE|")) continue;
try {
const vote = JSON.parse(message.content.substring("VOTE|".length));
if (vote.pollId !== poll.id) continue;
const existing = votes.get(vote.userId);
if (!existing || vote.timestamp > existing.timestamp) {
votes.set(vote.userId, vote);
}
} catch {}
}
await updatePublicImage();
scheduleClose();
}
/*
* SETUP FLOW — PART 1
* /poll command: images + names, then a modal for categories.
*/
async function startPollSetup(interaction) {
if (poll && poll.status === "active") {
return interaction.reply({
content: "There is already an active poll. Use `/endpoll` first.",
flags: MessageFlags.Ephemeral,
});
}
const targetChannel = interaction.options.getChannel("channel") || interaction.channel;
if (targetChannel.id === POLL_DATA_CHANNEL_ID) {
return interaction.reply({
content:
"That's the bot's private data channel (used to store poll info behind the scenes) — polls can't be posted there. Pick a different channel with the `channel` option, or run `/poll` from the channel you want it in.",
flags: MessageFlags.Ephemeral,
});
}
const duration = interaction.options.getString("duration");
const characters = [];
for (let i = 1; i <= CHARACTER_COUNT; i++) {
const image = interaction.options.getAttachment(`image${i}`);
const name = clean(interaction.options.getString(`name${i}`));
if (!image) {
return interaction.reply({
content: `Image ${i} is missing.`,
flags: MessageFlags.Ephemeral,
});
}
if (!name) {
return interaction.reply({
content: `Character name ${i} is missing.`,
flags: MessageFlags.Ephemeral,
});
}
characters.push({ name, url: image.url });
}
const setupId = makeId();
pendingSetups.set(interaction.user.id, {
setupId,
duration,
characters,
channelId: targetChannel.id,
});
setTimeout(() => {
const pending = pendingSetups.get(interaction.user.id);
if (pending && pending.setupId === setupId) {
pendingSetups.delete(interaction.user.id);
}
}, 10 * 60 * 1000);
const modal = new ModalBuilder()
.setCustomId("poll-categories")
.setTitle("Voting categories (up to 4)");
for (let i = 1; i <= CATEGORY_COUNT; i++) {
modal.addComponents(
new ActionRowBuilder().addComponents(
new TextInputBuilder()
.setCustomId(`cat${i}`)
.setLabel(`Category ${i}: symbol | label | result?`)
.setStyle(TextInputStyle.Short)
.setPlaceholder("?? | Marriage | Wedded")
.setRequired(true)
.setMaxLength(80)
)
);
}
await interaction.showModal(modal);
}
/*
* SETUP FLOW — PART 2
* Modal submit: parse categories, build everything, post the poll.
*/
async function finishPollSetup(interaction) {
const pending = pendingSetups.get(interaction.user.id);
if (!pending) {
return interaction.reply({
content: "Setup expired — please run `/poll` again.",
flags: MessageFlags.Ephemeral,
});
}
pendingSetups.delete(interaction.user.id);
if (poll && poll.status === "active") {
return interaction.reply({
content: "Someone already started a poll first. Use `/endpoll` then try again.",
flags: MessageFlags.Ephemeral,
});
}
await interaction.deferReply({ flags: MessageFlags.Ephemeral });
// Safety net against duplicate posts: if two instances of this bot are
// ever briefly running at once (e.g. mid-redeploy on Render), both can
// receive and act on the same modal submission. If a poll was already
// created in the last 20 seconds, assume that's what happened and stop
// here rather than posting a second one.
try {
const dataChannel = await getDataChannel();
const recent = await dataChannel.messages.fetch({ limit: 5 });
const justCreated = recent.find(
(message) =>
message.content?.startsWith("POLL_BASE|") &&
Date.now() - message.createdTimestamp < 20000
);
if (justCreated) {
return interaction.editReply(
"A poll was just created (likely by a duplicate bot process finishing a fraction of a second earlier). Check the channel — if it's not there, run `/poll` again."
);
}
} catch (error) {
console.error("Duplicate-poll safety check failed (continuing anyway):", error);
}
const symbols = [];
const voteLabels = [];
const resultLabels = [];
for (let i = 1; i <= CATEGORY_COUNT; i++) {
const raw = clean(interaction.fields.getTextInputValue(`cat${i}`));
const parts = raw.split("|").map((part) => part.trim());
const symbol = cleanSymbol(parts[0]);
const vote = clean(parts[1]);
const result = clean(parts[2]);
if (!symbol || !vote) {
return interaction.editReply(
`Category ${i} needs a symbol and a label separated by "|", e.g. ?? | Marriage`
);
}
symbols.push(symbol);
voteLabels.push(vote);
resultLabels.push(result || vote);
}
if (new Set(voteLabels.map((v) => v.toLowerCase())).size !== CATEGORY_COUNT) {
return interaction.editReply("The four category labels must all be different.");
}
const durationDays = { "1d": 1, "3d": 3, "7d": 7, "14d": 14 }[pending.duration];
const photos = [];
try {
for (const character of pending.characters) {
const raw = await downloadBuffer(character.url);
const resized = await sharp(raw)
.resize(PHOTO_WIDTH, PHOTO_HEIGHT, { fit: "cover", position: "centre" })
.jpeg({ quality: 92 })
.toBuffer();
photos.push(resized);
}
} catch (error) {
return interaction.editReply(`I couldn't process one of the images: ${error.message}`);
}
const symbolImages = await buildSymbolImages(symbols);
poll = {
id: makeId(),
duration: durationDays,
startTime: Date.now(),
endTime: Date.now() + durationDays * 24 * 60 * 60 * 1000,
publicChannelId: pending.channelId,
publicMessageId: null,
baseImageMessageId: null,
characters: pending.characters.map((character) => ({ name: character.name })),
photos,
voteLabels,
symbols,
symbolImages,
resultLabels,
characterLeaders: [[], [], [], [], []],
status: "active",
};
votes = new Map();
selections = new Map();
try {
await saveBaseImages();
const combined = await buildCombinedResultImage();
const channel = await client.channels.fetch(pending.channelId);
publicPollMessage = await channel.send({
files: [new AttachmentBuilder(combined, { name: "poll-results.jpg" })],
components: [buildVoteButtonRow()],
});
poll.publicMessageId = publicPollMessage.id;
await saveState();
scheduleClose();
await interaction.deleteReply();
} catch (error) {
console.error(error);
poll = null;
await interaction.editReply(`Something went wrong: ${error.message}`);
}
}
/*
* SLASH COMMANDS
*/
const pollCommand = new SlashCommandBuilder()
.setName("poll")
.setDescription("Create a four-character poll")
.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
.addStringOption((option) =>
option
.setName("duration")
.setDescription("How long the poll runs")
.setRequired(true)
.addChoices(
{ name: "1 day", value: "1d" },
{ name: "3 days", value: "3d" },
{ name: "7 days", value: "7d" },
{ name: "14 days", value: "14d" }
)
);
for (let i = 1; i <= CHARACTER_COUNT; i++) {
pollCommand.addAttachmentOption((option) =>
option.setName(`image${i}`).setDescription(`Picture ${i}`).setRequired(true)
);
}
for (let i = 1; i <= CHARACTER_COUNT; i++) {
pollCommand.addStringOption((option) =>
option.setName(`name${i}`).setDescription(`Character ${i} name`).setRequired(true)
);
}
// Optional options must come after all required ones (Discord API
// rule) — that's why this was moved down here.
pollCommand.addChannelOption((option) =>
option
.setName("channel")
.setDescription("Where to post the finished poll (defaults to this channel)")
.addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
.setRequired(false)
);
const endPollCommand = new SlashCommandBuilder()
.setName("endpoll")
.setDescription("End the current poll")
.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
async function registerCommands() {
const rest = new REST({ version: "10" }).setToken(TOKEN);
const body = [pollCommand.toJSON(), endPollCommand.toJSON()];
if (GUILD_ID) {
// Guild-specific commands appear instantly — use this while testing.
await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body });
// Clear out any old GLOBAL commands from before GUILD_ID was set, so
// there's no stale duplicate /poll (missing the channel option)
// sitting alongside the new one and causing confusion.
try {
await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
console.log("Cleared old global commands.");
} catch (error) {
console.error("Could not clear old global commands:", error.message);
}
} else {
// Global commands are visible in every server the bot is in, but can
// take up to an hour for Discord to fully propagate.
await rest.put(Routes.applicationCommands(client.user.id), { body });
}
}
/*
* BOT READY
*/
client.once("ready", async () => {
console.log(`Logged in as ${client.user.tag}`);
try {
await registerCommands();
console.log("Slash commands registered.");
await loadSavedPoll();
console.log("Startup complete.");
} catch (error) {
console.error("Startup error:", error);
}
});
/*
* INTERACTIONS
*/
client.on("interactionCreate", async (interaction) => {
try {
if (interaction.isChatInputCommand()) {
if (interaction.commandName === "poll") {
if (processingInteractions.has(interaction.id)) return;
processingInteractions.add(interaction.id);
try {
await startPollSetup(interaction);
} finally {
processingInteractions.delete(interaction.id);
}
return;
}
if (interaction.commandName === "endpoll") {
if (!poll || poll.status !== "active") {
return interaction.reply({
content: "There is no active poll.",
flags: MessageFlags.Ephemeral,
});
}
// Acknowledge within Discord's 3-second window FIRST — closePoll()
// rebuilds the result image and saves state, which is too slow to
// finish before that window closes if done beforehand.
await interaction.deferReply({ flags: MessageFlags.Ephemeral });
await closePoll();
return interaction.editReply({ content: "Poll ended." });
}
return;
}
if (interaction.isModalSubmit() && interaction.customId === "poll-categories") {
if (processingInteractions.has(interaction.id)) return;
processingInteractions.add(interaction.id);
try {
await finishPollSetup(interaction);
} finally {
processingInteractions.delete(interaction.id);
}
return;
}
if (interaction.isButton() && interaction.customId === "vote") {
await openVote(interaction);
return;
}
if (interaction.isButton() && interaction.customId === "confirm-vote") {
await confirmVote(interaction);
return;
}
if (interaction.isStringSelectMenu() && interaction.customId.startsWith("choice:")) {
await handleChoice(interaction);
return;
}
} catch (error) {
console.error(error);
try {
if (!interaction.replied && !interaction.deferred) {
await interaction.reply({
content: "Something went wrong.",
flags: MessageFlags.Ephemeral,
});
}
} catch {}
}
});
/*
* RENDER HEALTH SERVER
*/
http
.createServer((req, res) => {
res.writeHead(200, { "Content-Type": "text/plain" });
res.end("MayorBot is running.");
})
.listen(PORT, () => console.log(`Web server listening on ${PORT}`));
/*
* LOGIN
*/
client.login(TOKEN);
