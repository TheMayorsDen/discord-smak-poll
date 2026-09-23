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
  MessageFlags,
} = require("discord.js");
const sharp = require("sharp");

const TOKEN = process.env.DISCORD_TOKEN;
const POLL_DATA_CHANNEL_ID = process.env.POLL_DATA_CHANNEL_ID;

const PORT = process.env.PORT || 3000;

const PANEL_WIDTH = 500;
const PANEL_HEIGHT = 900;
const RESULT_HEIGHT = 150;

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

let poll = null;
let votes = new Map();
let selections = new Map();
let baseImageBuffer = null;

let stateMessageId = null;
let baseImageMessageId = null;
let publicPollMessage = null;
let controlMessage = null;
let closeTimer = null;

function makeId() {
  return `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function cleanText(value) {
  return String(value || "").trim();
}

function truncate(value, max = 28) {
  const text = cleanText(value);
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

async function downloadBuffer(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function calculateCounts() {
  const counts = Array.from(
    { length: poll.voteLabels.length },
    () => Array(poll.characters.length).fill(0)
  );

  for (const vote of votes.values()) {
    for (let character = 0; character < vote.choices.length; character++) {
      const option = vote.choices[character];

      if (
        option >= 0 &&
        option < poll.voteLabels.length
      ) {
        counts[option][character]++;
      }
    }
  }

  return counts;
}

function calculateWinners(counts) {
  const winners = [];

  for (let option = 0; option < poll.voteLabels.length; option++) {
    let bestCharacter = poll.winners?.[option] ?? option;
    let bestCount = counts[option][bestCharacter] || 0;

    for (let character = 0; character < poll.characters.length; character++) {
      const count = counts[option][character];

      if (count > bestCount) {
        bestCount = count;
        bestCharacter = character;
      }
    }

    winners.push(bestCharacter);
  }

  return winners;
}

function escapeSvg(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function resultFontSize(text, availableWidth) {
  const length = text.length;

  if (length <= 12) return Math.min(25, availableWidth / 8);
  if (length <= 20) return Math.min(21, availableWidth / 10);
  if (length <= 30) return Math.min(17, availableWidth / 12);
  return Math.min(14, availableWidth / 15);
}

function buildResultSvg(counts, winners) {
  const width = PANEL_WIDTH * 5;
  const height = RESULT_HEIGHT;

  let svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="#111111"/>
  `;

  for (let character = 0; character < 5; character++) {
    const characterOptions = [];

    for (let option = 0; option < 5; option++) {
      if (winners[option] === character) {
        characterOptions.push(option);
      }
    }

    if (characterOptions.length === 0) continue;

    const gap = 8;
    const totalGap = gap * (characterOptions.length - 1);
    const badgeWidth =
      (PANEL_WIDTH - 30 - totalGap) / characterOptions.length;

    characterOptions.forEach((option, index) => {
      const x =
        character * PANEL_WIDTH +
        15 +
        index * (badgeWidth + gap);

      const label =
        `${poll.resultLabels[option]} ${counts[option][character]}`;

      const fontSize = resultFontSize(label, badgeWidth);

      svg += `
        <rect
          x="${x}"
          y="35"
          width="${badgeWidth}"
          height="80"
          rx="18"
          fill="#242424"
          stroke="#ffffff"
          stroke-width="2"
        />

        <text
          x="${x + badgeWidth / 2}"
          y="84"
          text-anchor="middle"
          dominant-baseline="middle"
          fill="white"
          font-family="Arial, sans-serif"
          font-size="${fontSize}px"
          font-weight="700"
        >${escapeSvg(label)}</text>
      `;
    });
  }

  svg += `</svg>`;

  return Buffer.from(svg);
}

async function buildPollImage() {
  const counts = calculateCounts();
  const winners = calculateWinners(counts);

  poll.winners = winners;

  const panels = [];

  for (const character of poll.characters) {
    const image = await sharp(character.image)
      .resize(PANEL_WIDTH, PANEL_HEIGHT, {
        fit: "cover",
        position: "centre",
      })
      .jpeg({ quality: 90 })
      .toBuffer();

    panels.push(image);
  }

  const resultStrip = buildResultSvg(counts, winners);

  return sharp({
    create: {
      width: PANEL_WIDTH * 5,
      height: RESULT_HEIGHT + PANEL_HEIGHT,
      channels: 3,
      background: "#111111",
    },
  })
    .composite([
      {
        input: resultStrip,
        left: 0,
        top: 0,
      },
      ...panels.map((image, index) => ({
        input: image,
        left: index * PANEL_WIDTH,
        top: RESULT_HEIGHT,
      })),
    ])
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function getDataChannel() {
  const channel = await client.channels.fetch(POLL_DATA_CHANNEL_ID);

  if (!channel) {
    throw new Error("Could not find the MayorBot data channel.");
  }

  return channel;
}

async function getAllDataMessages() {
  const channel = await getDataChannel();

  const messages = [];
  let before;

  while (true) {
    const batch = await channel.messages.fetch({
      limit: 100,
      before,
    });

    if (!batch.size) break;

    messages.push(...batch.values());

    if (batch.size < 100) break;

    before = batch.last().id;
  }

  return messages;
}

async function saveState() {
  if (!poll) return;

  const channel = await getDataChannel();

  if (stateMessageId) {
    try {
      const oldMessage = await channel.messages.fetch(stateMessageId);
      await oldMessage.delete();
    } catch {}
  }

  const state = {
    schemaVersion: 2,
    pollId: poll.id,
    duration: poll.duration,
    startTime: poll.startTime,
    endTime: poll.endTime,
    publicChannelId: poll.publicChannelId,
    publicMessageId: poll.publicMessageId,
    controlMessageId: poll.controlMessageId,
    baseImageMessageId: poll.baseImageMessageId,
    characters: poll.characters.map((c) => ({
      name: c.name,
    })),
    voteLabels: poll.voteLabels,
    resultLabels: poll.resultLabels,
    winners: poll.winners,
    status: poll.status,
  };

  const message = await channel.send(
    `POLL_STATE|${JSON.stringify(state)}`
  );

  stateMessageId = message.id;
}

async function saveVote(userId, choices) {
  const channel = await getDataChannel();

  const vote = {
    pollId: poll.id,
    userId,
    choices,
    timestamp: Date.now(),
  };

  await channel.send(`VOTE|${JSON.stringify(vote)}`);
}

async function saveBaseImage() {
  const channel = await getDataChannel();

  const attachment = new AttachmentBuilder(
    baseImageBuffer,
    { name: "poll-base.jpg" }
  );

  const message = await channel.send({
    content: `POLL_BASE|${poll.id}`,
    files: [attachment],
  });

  baseImageMessageId = message.id;
  poll.baseImageMessageId = message.id;
}

async function loadSavedPoll() {
  const messages = await getAllDataMessages();

  const stateMessages = messages
    .filter((m) => m.content.startsWith("POLL_STATE|"))
    .sort((a, b) => b.createdTimestamp - a.createdTimestamp);

  if (!stateMessages.length) return;

  const latest = stateMessages[0];

  let saved;

  try {
    saved = JSON.parse(
      latest.content.substring("POLL_STATE|".length)
    );
  } catch {
    return;
  }

  /*
   * Old version of the bot.
   * Close the old test poll rather than trying to use the old layout.
   */
  if (saved.schemaVersion !== 2) {
    try {
      const channel = await client.channels.fetch(saved.publicChannelId);
      const message = await channel.messages.fetch(saved.publicMessageId);

      await message.edit({
        content: "POLL CLOSED",
        components: [],
      });
    } catch {}

    return;
  }

  if (saved.status !== "active") return;

  if (saved.endTime <= Date.now()) {
    return;
  }

  poll = {
    ...saved,
    characters: saved.characters.map((character) => ({
      name: character.name,
      image: null,
    })),
  };

  stateMessageId = latest.id;
  baseImageMessageId = saved.baseImageMessageId;

  const dataChannel = await getDataChannel();

  try {
    const baseMessage = await dataChannel.messages.fetch(
      saved.baseImageMessageId
    );

    const attachment = baseMessage.attachments.first();

    if (!attachment) {
      throw new Error("Base image missing.");
    }

    baseImageBuffer = await downloadBuffer(attachment.url);
  } catch {
    poll = null;
    return;
  }

  const publicChannel = await client.channels.fetch(
    poll.publicChannelId
  );

  publicPollMessage = await publicChannel.messages.fetch(
    poll.publicMessageId
  );

  if (poll.controlMessageId) {
    try {
      controlMessage = await publicChannel.messages.fetch(
        poll.controlMessageId
      );
    } catch {}
  }

  votes = new Map();

  for (const message of messages) {
    if (!message.content.startsWith("VOTE|")) continue;

    try {
      const vote = JSON.parse(
        message.content.substring("VOTE|".length)
      );

      if (vote.pollId !== poll.id) continue;

      const existing = votes.get(vote.userId);

      if (
        !existing ||
        vote.timestamp > existing.timestamp
      ) {
        votes.set(vote.userId, vote);
      }
    } catch {}
  }

  await updatePublicResults();
  schedulePollClose();
}

function schedulePollClose() {
  if (closeTimer) {
    clearTimeout(closeTimer);
  }

  if (!poll) return;

  const remaining = poll.endTime - Date.now();

  if (remaining <= 0) {
    closePoll();
    return;
  }

  closeTimer = setTimeout(
    schedulePollClose,
    Math.min(remaining, 24 * 60 * 60 * 1000)
  );

  if (remaining <= 24 * 60 * 60 * 1000) {
    clearTimeout(closeTimer);

    closeTimer = setTimeout(
      closePoll,
      remaining
    );
  }
}

async function updatePublicResults() {
  if (!poll || !publicPollMessage || !baseImageBuffer) return;

  const counts = calculateCounts();
  const winners = calculateWinners(counts);

  poll.winners = winners;

  const image = await buildPollImage();

  const attachment = new AttachmentBuilder(
    image,
    { name: "poll-results.jpg" }
  );

  await publicPollMessage.edit({
    content: null,
    attachments: [],
    files: [attachment],
  });
}

function buildVoteMenus(userId) {
  const current = selections.get(userId) || Array(5).fill(null);

  return poll.characters.map((character, characterIndex) => {
    const usedOptions = new Set(
      current.filter((value) => value !== null)
    );

    const availableOptions = poll.voteLabels
      .map((label, optionIndex) => ({
        label,
        optionIndex,
      }))
      .filter(({ optionIndex }) =>
        !usedOptions.has(optionIndex) ||
        current[characterIndex] === optionIndex
      );

    const menu = new StringSelectMenuBuilder()
      .setCustomId(`choice:${characterIndex}`)
      .setPlaceholder(
        `${truncate(character.name, 35)} — choose`
      )
      .addOptions(
        availableOptions.map(({ label, optionIndex }) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(truncate(label, 100))
            .setValue(String(optionIndex))
            .setDefault(
              current[characterIndex] === optionIndex
            )
        )
      );

    return new ActionRowBuilder().addComponents(menu);
  });
}

async function openVotingPanel(interaction) {
  if (!poll || poll.status !== "active") {
    return interaction.reply({
      content: "This poll is closed.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const existingVote = votes.get(interaction.user.id);

  if (existingVote) {
    selections.set(
      interaction.user.id,
      [...existingVote.choices]
    );
  } else {
    selections.set(
      interaction.user.id,
      Array(5).fill(null)
    );
  }

  return interaction.reply({
    components: buildVoteMenus(interaction.user.id),
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

  const characterIndex = Number(
    interaction.customId.split(":")[1]
  );

  const optionIndex = Number(
    interaction.values[0]
  );

  let current =
    selections.get(interaction.user.id) ||
    Array(5).fill(null);

  current = [...current];

  current[characterIndex] = optionIndex;

  selections.set(
    interaction.user.id,
    current
  );

  await interaction.update({
    components: buildVoteMenus(interaction.user.id),
  });
}

async function confirmVote(interaction) {
  if (!poll || poll.status !== "active") {
    return interaction.reply({
      content: "This poll is closed.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const current = selections.get(interaction.user.id);

  if (
    !current ||
    current.length !== 5 ||
    current.some((value) => value === null)
  ) {
    return interaction.reply({
      content: "Please choose one option for all five characters first.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const unique = new Set(current);

  if (unique.size !== 5) {
    return interaction.reply({
      content: "Each option must be used exactly once.",
      flags: MessageFlags.Ephemeral,
    });
  }

  votes.set(interaction.user.id, {
    choices: [...current],
    timestamp: Date.now(),
  });

  await saveVote(
    interaction.user.id,
    current
  );

  await updatePublicResults();
  await saveState();

  return interaction.reply({
    content: "Vote confirmed.",
    flags: MessageFlags.Ephemeral,
  });
}

async function closePoll() {
  if (!poll) return;

  poll.status = "closed";

  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }

  try {
    if (publicPollMessage) {
      await publicPollMessage.edit({
        content: "POLL CLOSED",
        attachments: [],
        components: [],
      });
    }
  } catch {}

  try {
    if (controlMessage) {
      await controlMessage.edit({
        components: controlMessage.components.map((row) =>
          new ActionRowBuilder().addComponents(
            row.components.map((component) =>
              ButtonBuilder.from(component).setDisabled(true)
            )
          )
        ),
      });
    }
  } catch {}

  await saveState();

  selections.clear();
}

async function createPoll(interaction) {
  if (poll && poll.status === "active") {
    return interaction.reply({
      content: "There is already an active poll. Use `/endpoll` first.",
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral,
  });

  const durationChoice =
    interaction.options.getString("duration");

  const durationMap = {
    "1d": 1,
    "3d": 3,
    "7d": 7,
    "14d": 14,
  };

  const durationDays = durationMap[durationChoice];

  const characters = [];

  for (let i = 1; i <= 5; i++) {
    const attachment =
      interaction.options.getAttachment(`image${i}`);

    const name =
      cleanText(
        interaction.options.getString(`name${i}`)
      );

    if (!attachment) {
      return interaction.editReply(
        `Image ${i} is missing.`
      );
    }

    if (!name) {
      return interaction.editReply(
        `Character name ${i} is missing.`
      );
    }

    characters.push({
      name,
      attachmentUrl: attachment.url,
    });
  }

  const voteLabels = [];

  for (let i = 1; i <= 5; i++) {
    const label = cleanText(
      interaction.options.getString(`vote${i}`)
    );

    if (!label) {
      return interaction.editReply(
        `Voting option ${i} is missing.`
      );
    }

    voteLabels.push(label);
  }

  if (new Set(voteLabels.map((x) => x.toLowerCase())).size !== 5) {
    return interaction.editReply(
      "All five voting options must have different names."
    );
  }

  const resultLabels = [];

  for (let i = 1; i <= 5; i++) {
    const entered = cleanText(
      interaction.options.getString(`result${i}`)
    );

    resultLabels.push(
      entered || voteLabels[i - 1]
    );
  }

  if (
    new Set(
      resultLabels.map((x) => x.toLowerCase())
    ).size !== 5
  ) {
    return interaction.editReply(
      "All five ranking/result names must have different names."
    );
  }

  const imageBuffers = [];

  try {
    for (const character of characters) {
      imageBuffers.push(
        await downloadBuffer(character.attachmentUrl)
      );
    }
  } catch (error) {
    return interaction.editReply(
      `I couldn't process one of the images: ${error.message}`
    );
  }

  poll = {
    id: makeId(),
    duration: durationDays,
    startTime: Date.now(),
    endTime:
      Date.now() +
      durationDays * 24 * 60 * 60 * 1000,
    publicChannelId: interaction.channelId,
    publicMessageId: null,
    controlMessageId: null,
    baseImageMessageId: null,
    characters: characters.map((character, index) => ({
      name: character.name,
      image: imageBuffers[index],
    })),
    voteLabels,
    resultLabels,
    winners: [0, 1, 2, 3, 4],
    status: "active",
  };

  votes = new Map();
  selections = new Map();

  try {
    baseImageBuffer = await buildPollImage();

    await saveBaseImage();

    const resultImage = await buildPollImage();

    const resultAttachment = new AttachmentBuilder(
      resultImage,
      { name: "poll-results.jpg" }
    );

    publicPollMessage =
      await interaction.channel.send({
        files: [resultAttachment],
      });

    poll.publicMessageId =
      publicPollMessage.id;

    const voteButton =
      new ButtonBuilder()
        .setCustomId("vote")
        .setLabel("VOTE / CHANGE VOTE")
        .setStyle(ButtonStyle.Primary);

    const confirmButton =
      new ButtonBuilder()
        .setCustomId("confirm")
        .setLabel("CONFIRM VOTE")
        .setStyle(ButtonStyle.Success);

    const controlRow =
      new ActionRowBuilder().addComponents(
        voteButton,
        confirmButton
      );

    controlMessage =
      await interaction.channel.send({
        components: [controlRow],
      });

    poll.controlMessageId =
      controlMessage.id;

    await saveState();

    schedulePollClose();

    await interaction.editReply(
      "Poll created."
    );
  } catch (error) {
    console.error(error);

    poll = null;
    baseImageBuffer = null;

    await interaction.editReply(
      `Something went wrong creating the poll: ${error.message}`
    );
  }
}

const pollCommand = new SlashCommandBuilder()
  .setName("poll")
  .setDescription("Create a five-character poll")
  .setDefaultMemberPermissions(
    PermissionFlagsBits.ManageGuild
  )
  .addStringOption((option) =>
    option
      .setName("duration")
      .setDescription("How long the poll should run")
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
    option
      .setName(`image${i}`)
      .setDescription(`Picture for character ${i}`)
      .setRequired(true)
  );
}

for (let i = 1; i <= 5; i++) {
  pollCommand.addStringOption((option) =>
    option
      .setName(`name${i}`)
      .setDescription(`Name of character ${i}`)
      .setRequired(true)
  );
}

for (let i = 1; i <= 5; i++) {
  pollCommand.addStringOption((option) =>
    option
      .setName(`vote${i}`)
      .setDescription(`Voting option ${i}`)
      .setRequired(true)
  );
}

for (let i = 1; i <= 5; i++) {
  pollCommand.addStringOption((option) =>
    option
      .setName(`result${i}`)
      .setDescription(
        `Ranking name ${i} (leave blank to use voting option ${i})`
      )
      .setRequired(false)
  );
}

const endPollCommand = new SlashCommandBuilder()
  .setName("endpoll")
  .setDescription("End the current poll")
  .setDefaultMemberPermissions(
    PermissionFlagsBits.ManageGuild
  );

async function registerCommands() {
  const rest = new REST({ version: "10" })
    .setToken(TOKEN);

  await rest.put(
    Routes.applicationCommands(client.user.id),
    {
      body: [
        pollCommand.toJSON(),
        endPollCommand.toJSON(),
      ],
    }
  );
}

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

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "poll") {
        await createPoll(interaction);
        return;
      }

      if (interaction.commandName === "endpoll") {
        if (!poll || poll.status !== "active") {
          await interaction.reply({
            content: "There is no active poll.",
            flags: MessageFlags.Ephemeral,
          });

          return;
        }

        await closePoll();

        await interaction.reply({
          content: "Poll ended.",
          flags: MessageFlags.Ephemeral,
        });

        return;
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId === "vote") {
        await openVotingPanel(interaction);
        return;
      }

      if (interaction.customId === "confirm") {
        await confirmVote(interaction);
        return;
      }
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith("choice:")) {
        await handleChoice(interaction);
        return;
      }
    }
  } catch (error) {
    console.error(error);

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "Something went wrong.",
        flags: MessageFlags.Ephemeral,
      });
    }
  }
});

http
  .createServer((req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/plain",
    });

    res.end("MayorBot is running.");
  })
  .listen(PORT, () => {
    console.log(`Web server listening on ${PORT}`);
  });

client.login(TOKEN);
