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
} = require("discord.js");

const sharp = require("sharp");

const TOKEN = process.env.DISCORD_TOKEN;
const POLL_DATA_CHANNEL_ID = process.env.POLL_DATA_CHANNEL_ID;
const PORT = process.env.PORT || 3000;

/*
 * Each character gets its OWN image (not one giant
 * stitched image). Discord displays multiple attachments
 * in a message as a grid, and each one renders much
 * larger than a slice of one super-wide image would.
 */
const PHOTO_WIDTH = 700;
const PHOTO_HEIGHT = 1050;
const BADGE_HEIGHT = 120; // top: winning category name
const SYMBOL_BAR_HEIGHT = 140; // bottom: symbols + counts

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
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Image download failed: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
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
  const counts = Array.from({ length: 5 }, () => Array(5).fill(0));

  for (const vote of votes.values()) {
    if (!vote.choices) continue;

    for (let character = 0; character < 5; character++) {
      const option = vote.choices[character];
      if (option >= 0 && option < 5) {
        counts[option][character]++;
      }
    }
  }

  return counts;
}

function getCharacterLeaders(counts) {
  const leaders = [];

  for (let character = 0; character < 5; character++) {
    let highest = 0;
    const winningOptions = [];

    for (let option = 0; option < 5; option++) {
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
 *   [ winning category badge(s) ]
 *   [           photo           ]
 *   [   symbols + vote counts   ]
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
      const fontSize = textSize(label, badgeWidth);

      svg += `
        <rect x="${x}" y="14" width="${badgeWidth}" height="${BADGE_HEIGHT - 28}"
          rx="16" fill="#242424" stroke="#ffffff" stroke-width="2"/>
        <text x="${x + badgeWidth / 2}" y="${BADGE_HEIGHT / 2}"
          text-anchor="middle" dominant-baseline="middle" fill="white"
          font-family="Arial, sans-serif" font-size="${fontSize}px" font-weight="700">
          ${escapeSvg(truncate(label, 35))}
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

  const cellWidth = width / 5;

  for (let option = 0; option < 5; option++) {
    const count = counts[option][characterIndex];
    const centerX = cellWidth * option + cellWidth / 2;
    const symbol = cleanSymbol(poll.symbols[option]);

    svg += `
      <text x="${centerX}" y="${barY + SYMBOL_BAR_HEIGHT / 2 - 16}"
        text-anchor="middle" dominant-baseline="middle" fill="white"
        font-family="Arial, Noto Color Emoji, Segoe UI Emoji, sans-serif" font-size="38px">
        ${escapeSvg(symbol)}
      </text>
      <text x="${centerX}" y="${barY + SYMBOL_BAR_HEIGHT / 2 + 28}"
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

  return await sharp({
    create: {
      width: PHOTO_WIDTH,
      height,
      channels: 3,
      background: "#111111",
    },
  })
    .composite([
      { input: poll.photos[characterIndex], top: BADGE_HEIGHT, left: 0 },
      { input: overlay, top: 0, left: 0 },
    ])
    .jpeg({ quality: 92 })
    .toBuffer();
}

async function buildAllResultImages() {
  const counts = getCounts();
  const leaders = getCharacterLeaders(counts);
  poll.characterLeaders = leaders;

  const images = [];
  for (let i = 0; i < 5; i++) {
    images.push(await buildCharacterResultImage(i, counts, leaders));
  }
  return images;
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
 * Just the 5 photos + one "Vote / Change Vote" button.
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

  const images = await buildAllResultImages();

  await publicPollMessage.edit({
    content: poll.status === "active" ? null : "🔒 Poll closed — thanks for voting!",
    attachments: [],
    files: images.map(
      (buffer, index) =>
        new AttachmentBuilder(buffer, { name: `poll-${index}.jpg` })
    ),
    components: [buildVoteButtonRow(poll.status !== "active")],
  });
}

/*
 * PRIVATE VOTE PANEL
 *
 * All 5 dropdowns shown together, one per character.
 * The vote saves automatically the moment all 5 are set.
 */

function buildCategorySelectRow(userId, characterIndex) {
  const current = selections.get(userId) || Array(5).fill(null);
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

function buildCategorySelectRows(userId) {
  return [0, 1, 2, 3, 4].map((index) => buildCategorySelectRow(userId, index));
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
      previous ? [...previous.choices] : Array(5).fill(null)
    );
  }

  const current = selections.get(interaction.user.id);
  const assigned = current.filter((value) => value !== null).length;

  return interaction.reply({
    content: `Pick one category per character (${assigned}/5 chosen). Your vote saves automatically once all five are set.`,
    components: buildCategorySelectRows(interaction.user.id),
    flags: MessageFlags.Ephemeral,
  });
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
    characterIndex >= 5 ||
    optionIndex < 0 ||
    optionIndex >= 5
  ) {
    return interaction.reply({
      content: "Invalid selection.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const current = selections.get(interaction.user.id) || Array(5).fill(null);

  for (let index = 0; index < 5; index++) {
    if (index !== characterIndex && current[index] === optionIndex) {
      return interaction.reply({
        content: "That category is already assigned to another character.",
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  current[characterIndex] = optionIndex;
  selections.set(interaction.user.id, [...current]);

  const assigned = current.filter((value) => value !== null).length;
  let content;

  if (assigned === 5) {
    votes.set(interaction.user.id, {
      choices: [...current],
      timestamp: Date.now(),
    });

    await saveVote(interaction.user.id, current);
    await updatePublicImage();
    await saveState();

    content = "✅ Vote submitted! You can still change any pick below.";
  } else {
    content = `Pick one category per character (${assigned}/5 chosen). Your vote saves automatically once all five are set.`;
  }

  await interaction.update({
    content,
    components: buildCategorySelectRows(interaction.user.id),
  });
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

    if (attachments.length !== 5) {
      throw new Error("Expected 5 base images.");
    }

    poll.photos = await Promise.all(attachments.map((a) => downloadBuffer(a.url)));
  } catch (error) {
    console.error("Could not restore base images:", error);
    poll = null;
    return;
  }

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

  const duration = interaction.options.getString("duration");
  const characters = [];

  for (let i = 1; i <= 5; i++) {
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
    channelId: interaction.channelId,
  });

  setTimeout(() => {
    const pending = pendingSetups.get(interaction.user.id);
    if (pending && pending.setupId === setupId) {
      pendingSetups.delete(interaction.user.id);
    }
  }, 10 * 60 * 1000);

  const modal = new ModalBuilder()
    .setCustomId("poll-categories")
    .setTitle("Voting categories (up to 5)");

  for (let i = 1; i <= 5; i++) {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(`cat${i}`)
          .setLabel(`Category ${i}: symbol | label | result?`)
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("💍 | Marriage | Wedded")
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

  const symbols = [];
  const voteLabels = [];
  const resultLabels = [];

  for (let i = 1; i <= 5; i++) {
    const raw = clean(interaction.fields.getTextInputValue(`cat${i}`));
    const parts = raw.split("|").map((part) => part.trim());

    const symbol = cleanSymbol(parts[0]);
    const vote = clean(parts[1]);
    const result = clean(parts[2]);

    if (!symbol || !vote) {
      return interaction.editReply(
        `Category ${i} needs a symbol and a label separated by "|", e.g. 💍 | Marriage`
      );
    }

    symbols.push(symbol);
    voteLabels.push(vote);
    resultLabels.push(result || vote);
  }

  if (new Set(voteLabels.map((v) => v.toLowerCase())).size !== 5) {
    return interaction.editReply("The five category labels must all be different.");
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
    resultLabels,
    characterLeaders: [[], [], [], [], []],
    status: "active",
  };

  votes = new Map();
  selections = new Map();

  try {
    await saveBaseImages();

    const images = await buildAllResultImages();
    const channel = await client.channels.fetch(pending.channelId);

    publicPollMessage = await channel.send({
      files: images.map(
        (buffer, index) => new AttachmentBuilder(buffer, { name: `poll-${index}.jpg` })
      ),
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
  .setDescription("Create a five-character poll")
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

for (let i = 1; i <= 5; i++) {
  pollCommand.addAttachmentOption((option) =>
    option.setName(`image${i}`).setDescription(`Picture ${i}`).setRequired(true)
  );
}

for (let i = 1; i <= 5; i++) {
  pollCommand.addStringOption((option) =>
    option.setName(`name${i}`).setDescription(`Character ${i} name`).setRequired(true)
  );
}

const endPollCommand = new SlashCommandBuilder()
  .setName("endpoll")
  .setDescription("End the current poll")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);

  await rest.put(Routes.applicationCommands(client.user.id), {
    body: [pollCommand.toJSON(), endPollCommand.toJSON()],
  });
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

        await closePoll();

        return interaction.reply({
          content: "Poll ended.",
          flags: MessageFlags.Ephemeral,
        });
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
