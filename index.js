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

const IMAGE_WIDTH = 600;
const IMAGE_HEIGHT = 1000;
const TOP_HEIGHT = 115;
const BOTTOM_HEIGHT = 95;
const GAP = 4;

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

let poll = null;
let votes = new Map();
let selections = new Map();

let baseImageBuffer = null;
let publicPollMessage = null;
let controlMessage = null;
let stateMessageId = null;
let baseImageMessageId = null;
let closeTimer = null;

function makeId() {
  return `${Date.now()}-${Math.floor(Math.random() * 1000000000)}`;
}

function clean(value) {
  return String(value || "").trim();
}

function truncate(value, max) {
  const text = clean(value);
  return text.length > max
    ? text.slice(0, max - 1) + "…"
    : text;
}

function escapeSvg(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
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

function getCounts() {
  const counts = Array.from(
    { length: 5 },
    () => Array(5).fill(0)
  );

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

/*
 * Finds the most-voted category FOR EACH CHARACTER.
 *
 * If two or more categories are tied for first place,
 * all tied categories are displayed above that character.
 */
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

function textSize(text, width) {
  const length = text.length;

  if (length <= 12) return Math.min(25, width / 8);
  if (length <= 20) return Math.min(20, width / 10);
  if (length <= 30) return Math.min(16, width / 12);

  return Math.min(13, width / 15);
}

function buildOverlaySvg(counts, leaders) {
  const width =
    IMAGE_WIDTH * 5 +
    GAP * 4;

  const height =
    TOP_HEIGHT +
    IMAGE_HEIGHT +
    BOTTOM_HEIGHT;

  let svg = `
    <svg
      width="${width}"
      height="${height}"
      xmlns="http://www.w3.org/2000/svg"
    >

      <rect
        width="${width}"
        height="${height}"
        fill="#111111"
      />
  `;

  /*
   * TOP
   * Most-voted category for each character.
   */
  for (let character = 0; character < 5; character++) {
    const winningOptions = leaders[character];

    if (!winningOptions.length) continue;

    const sectionX =
      character * (IMAGE_WIDTH + GAP);

    const availableWidth =
      IMAGE_WIDTH - 20;

    const badgeGap = 6;

    const badgeWidth =
      (
        availableWidth -
        badgeGap * (winningOptions.length - 1)
      ) / winningOptions.length;

    winningOptions.forEach((option, index) => {
      const x =
        sectionX +
        10 +
        index * (badgeWidth + badgeGap);

      const label =
        poll.resultLabels[option];

      const fontSize =
        textSize(label, badgeWidth);

      svg += `
        <rect
          x="${x}"
          y="15"
          width="${badgeWidth}"
          height="80"
          rx="18"
          fill="#242424"
          stroke="#ffffff"
          stroke-width="2"
        />

        <text
          x="${x + badgeWidth / 2}"
          y="55"
          text-anchor="middle"
          dominant-baseline="middle"
          fill="white"
          font-family="Arial, sans-serif"
          font-size="${fontSize}px"
          font-weight="700"
        >
          ${escapeSvg(truncate(label, 35))}
        </text>
      `;
    });
  }

  /*
   * BOTTOM
   * Symbol + total votes for each category.
   */
  const bottomY =
    TOP_HEIGHT +
    IMAGE_HEIGHT;

  const cellWidth =
    width / 5;

  for (let option = 0; option < 5; option++) {
    const total =
      counts[option].reduce(
        (sum, value) => sum + value,
        0
      );

    const centerX =
      cellWidth * option +
      cellWidth / 2;

    const symbol =
      poll.symbols[option];

    svg += `
      <text
        x="${centerX - 18}"
        y="${bottomY + 58}"
        text-anchor="middle"
        dominant-baseline="middle"
        fill="white"
        font-family="Arial, sans-serif"
        font-size="36px"
      >
        ${escapeSvg(symbol)}
      </text>

      <text
        x="${centerX + 24}"
        y="${bottomY + 58}"
        text-anchor="middle"
        dominant-baseline="middle"
        fill="white"
        font-family="Arial, sans-serif"
        font-size="30px"
        font-weight="700"
      >
        ${total}
      </text>
    `;
  }

  svg += `</svg>`;

  return Buffer.from(svg);
}

/*
 * Creates the clean five-character image.
 * This is what gets stored privately in #mayorbot-data.
 */
async function buildBaseImage() {
  const width =
    IMAGE_WIDTH * 5 +
    GAP * 4;

  const height =
    TOP_HEIGHT +
    IMAGE_HEIGHT +
    BOTTOM_HEIGHT;

  const panels = [];

  for (const character of poll.characters) {
    const image =
      await sharp(character.image)
        .resize(
          IMAGE_WIDTH,
          IMAGE_HEIGHT,
          {
            fit: "cover",
            position: "centre",
          }
        )
        .jpeg({
          quality: 92,
        })
        .toBuffer();

    panels.push(image);
  }

  return await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: "#111111",
    },
  })
    .composite(
      panels.map((image, index) => ({
        input: image,
        left:
          index *
          (IMAGE_WIDTH + GAP),
        top: TOP_HEIGHT,
      }))
    )
    .jpeg({
      quality: 92,
    })
    .toBuffer();
}

async function buildPollImage() {
  const counts = getCounts();
  const leaders = getCharacterLeaders(counts);

  poll.characterLeaders = leaders;

  const overlay =
    buildOverlaySvg(
      counts,
      leaders
    );

  return await sharp(baseImageBuffer)
    .composite([
      {
        input: overlay,
        left: 0,
        top: 0,
      },
    ])
    .jpeg({
      quality: 92,
    })
    .toBuffer();
}

async function saveBaseImage() {
  const channel =
    await getDataChannel();

  const attachment =
    new AttachmentBuilder(
      baseImageBuffer,
      {
        name: "poll-base.jpg",
      }
    );

  const message =
    await channel.send({
      content:
        `POLL_BASE|${poll.id}`,
      files: [attachment],
    });

  baseImageMessageId =
    message.id;

  poll.baseImageMessageId =
    message.id;
}

async function saveVote(
  userId,
  choices
) {
  const channel =
    await getDataChannel();

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

  const channel =
    await getDataChannel();

  if (stateMessageId) {
    try {
      const old =
        await channel.messages.fetch(
          stateMessageId
        );

      await old.delete();
    } catch {}
  }

  const state = {
    schemaVersion: 4,

    pollId: poll.id,

    duration:
      poll.duration,

    startTime:
      poll.startTime,

    endTime:
      poll.endTime,

    publicChannelId:
      poll.publicChannelId,

    publicMessageId:
      poll.publicMessageId,

    controlMessageId:
      poll.controlMessageId,

    baseImageMessageId:
      poll.baseImageMessageId,

    characters:
      poll.characters.map(
        (character) => ({
          name: character.name,
        })
      ),

    voteLabels:
      poll.voteLabels,

    symbols:
      poll.symbols,

    resultLabels:
      poll.resultLabels,

    characterLeaders:
      poll.characterLeaders,

    status:
      poll.status,
  };

  const message =
    await channel.send(
      `POLL_STATE|${JSON.stringify(state)}`
    );

  stateMessageId =
    message.id;
}

function buildMenus(userId) {
  const current =
    selections.get(userId) ||
    Array(5).fill(null);

  return poll.characters.map(
    (character, characterIndex) => {

      const used =
        new Set(
          current.filter(
            (value) =>
              value !== null
          )
        );

      const available =
        poll.voteLabels
          .map(
            (label, optionIndex) => ({
              label,
              optionIndex,
            })
          )
          .filter(
            ({ optionIndex }) =>
              !used.has(optionIndex) ||
              current[characterIndex] ===
                optionIndex
          );

      const menu =
        new StringSelectMenuBuilder()
          .setCustomId(
            `choice:${characterIndex}`
          )
          .setPlaceholder(
            `${truncate(
              character.name,
              32
            )} — choose`
          )
          .addOptions(
            available.map(
              ({
                label,
                optionIndex,
              }) =>
                new StringSelectMenuOptionBuilder()
                  .setLabel(
                    truncate(
                      label,
                      100
                    )
                  )
                  .setValue(
                    String(optionIndex)
                  )
                  .setDefault(
                    current[
                      characterIndex
                    ] === optionIndex
                  )
            )
          );

      return new ActionRowBuilder()
        .addComponents(menu);
    }
  );
}

async function updatePublicImage() {
  if (
    !poll ||
    !publicPollMessage
  ) {
    return;
  }

  const image =
    await buildPollImage();

  const attachment =
    new AttachmentBuilder(
      image,
      {
        name:
          "poll-results.jpg",
      }
    );

  await publicPollMessage.edit({
    content: null,
    attachments: [],
    files: [attachment],
  });
}

async function openVote(interaction) {
  if (
    !poll ||
    poll.status !== "active"
  ) {
    return interaction.reply({
      content:
        "This poll is closed.",
      flags:
        MessageFlags.Ephemeral,
    });
  }

  const previous =
    votes.get(
      interaction.user.id
    );

  selections.set(
    interaction.user.id,
    previous
      ? [...previous.choices]
      : Array(5).fill(null)
  );

  await interaction.reply({
    components:
      buildMenus(
        interaction.user.id
      ),
    flags:
      MessageFlags.Ephemeral,
  });
}

async function handleChoice(
  interaction
) {
  if (
    !poll ||
    poll.status !== "active"
  ) {
    return interaction.reply({
      content:
        "This poll is closed.",
      flags:
        MessageFlags.Ephemeral,
    });
  }

  const characterIndex =
    Number(
      interaction.customId
        .split(":")[1]
    );

  const optionIndex =
    Number(
      interaction.values[0]
    );

  const current =
    selections.get(
      interaction.user.id
    ) ||
    Array(5).fill(null);

  current[characterIndex] =
    optionIndex;

  selections.set(
    interaction.user.id,
    [...current]
  );

  await interaction.update({
    components:
      buildMenus(
        interaction.user.id
      ),
  });
}

async function confirmVote(
  interaction
) {
  if (
    !poll ||
    poll.status !== "active"
  ) {
    return interaction.reply({
      content:
        "This poll is closed.",
      flags:
        MessageFlags.Ephemeral,
    });
  }

  const choices =
    selections.get(
      interaction.user.id
    );

  if (
    !choices ||
    choices.length !== 5 ||
    choices.some(
      (value) => value === null
    )
  ) {
    return interaction.reply({
      content:
        "Please choose one option for all five characters first.",
      flags:
        MessageFlags.Ephemeral,
    });
  }

  if (
    new Set(choices).size !== 5
  ) {
    return interaction.reply({
      content:
        "Each option must be used exactly once.",
      flags:
        MessageFlags.Ephemeral,
    });
  }

  votes.set(
    interaction.user.id,
    {
      choices: [...choices],
      timestamp: Date.now(),
    }
  );

  await saveVote(
    interaction.user.id,
    choices
  );

  await updatePublicImage();
  await saveState();

  await interaction.reply({
    content:
      "Vote confirmed.",
    flags:
      MessageFlags.Ephemeral,
  });
}

async function closePoll() {
  if (!poll) return;

  poll.status =
    "closed";

  if (closeTimer) {
    clearTimeout(
      closeTimer
    );

    closeTimer = null;
  }

  /*
   * Keep the final results image visible.
   * Only disable the voting buttons.
   */
  try {
    if (controlMessage) {
      const disabledRows =
        controlMessage.components.map(
          (row) =>
            new ActionRowBuilder()
              .addComponents(
                row.components.map(
                  (component) =>
                    ButtonBuilder
                      .from(component)
                      .setDisabled(true)
                )
              )
        );

      await controlMessage.edit({
        components:
          disabledRows,
      });
    }
  } catch {}

  await saveState();

  selections.clear();
}

function scheduleClose() {
  if (!poll) return;

  if (closeTimer) {
    clearTimeout(
      closeTimer
    );
  }

  const remaining =
    poll.endTime -
    Date.now();

  if (remaining <= 0) {
    closePoll();
    return;
  }

  closeTimer =
    setTimeout(
      closePoll,
      remaining
    );
}

async function loadSavedPoll() {
  const messages =
    await getAllDataMessages();

  const stateMessages =
    messages
      .filter(
        (message) =>
          message.content.startsWith(
            "POLL_STATE|"
          )
      )
      .sort(
        (a, b) =>
          b.createdTimestamp -
          a.createdTimestamp
      );

  if (!stateMessages.length) {
    return;
  }

  let saved;

  try {
    saved =
      JSON.parse(
        stateMessages[0]
          .content
          .substring(
            "POLL_STATE|".length
          )
      );
  } catch {
    return;
  }

  /*
   * Only version 4 is used.
   * Older test polls are ignored.
   */
  if (
    saved.schemaVersion !== 4
  ) {
    return;
  }

  if (
    saved.status !== "active"
  ) {
    return;
  }

  if (
    saved.endTime <= Date.now()
  ) {
    return;
  }

  poll = {
    ...saved,

    characters:
      saved.characters.map(
        (character) => ({
          name:
            character.name,
          image:
            null,
        })
      ),
  };

  stateMessageId =
    stateMessages[0].id;

  baseImageMessageId =
    saved.baseImageMessageId;

  const dataChannel =
    await getDataChannel();

  /*
   * Restore the clean character strip.
   */
  try {
    const baseMessage =
      await dataChannel.messages.fetch(
        saved.baseImageMessageId
      );

    const attachment =
      baseMessage.attachments.first();

    if (!attachment) {
      throw new Error(
        "Base image missing."
      );
    }

    baseImageBuffer =
      await downloadBuffer(
        attachment.url
      );
  } catch (error) {
    console.error(
      "Could not restore base image:",
      error
    );

    poll = null;
    return;
  }

  const publicChannel =
    await client.channels.fetch(
      saved.publicChannelId
    );

  try {
    publicPollMessage =
      await publicChannel.messages.fetch(
        saved.publicMessageId
      );
  } catch {
    poll = null;
    return;
  }

  try {
    controlMessage =
      await publicChannel.messages.fetch(
        saved.controlMessageId
      );
  } catch {}

  votes = new Map();

  for (const message of messages) {
    if (
      !message.content.startsWith(
        "VOTE|"
      )
    ) {
      continue;
    }

    try {
      const vote =
        JSON.parse(
          message.content.substring(
            "VOTE|".length
          )
        );

      if (
        vote.pollId !==
        poll.id
      ) {
        continue;
      }

      const existing =
        votes.get(
          vote.userId
        );

      if (
        !existing ||
        vote.timestamp >
          existing.timestamp
      ) {
        votes.set(
          vote.userId,
          vote
        );
      }
    } catch {}
  }

  await updatePublicImage();

  scheduleClose();
}

async function createPoll(
  interaction
) {
  if (
    poll &&
    poll.status === "active"
  ) {
    return interaction.reply({
      content:
        "There is already an active poll. Use `/endpoll` first.",
      flags:
        MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({
    flags:
      MessageFlags.Ephemeral,
  });

  const duration =
    interaction.options.getString(
      "duration"
    );

  const durationDays =
    {
      "1d": 1,
      "3d": 3,
      "7d": 7,
      "14d": 14,
    }[duration];

  const characters = [];

  for (let i = 1; i <= 5; i++) {
    const image =
      interaction.options.getAttachment(
        `image${i}`
      );

    const name =
      clean(
        interaction.options.getString(
          `name${i}`
        )
      );

    if (!image) {
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
      url: image.url,
    });
  }

  const voteLabels = [];
  const symbols = [];

  for (let i = 1; i <= 5; i++) {
    const symbol =
      clean(
        interaction.options.getString(
          `symbol${i}`
        )
      );

    const vote =
      clean(
        interaction.options.getString(
          `vote${i}`
        )
      );

    if (!symbol) {
      return interaction.editReply(
        `Symbol ${i} is missing.`
      );
    }

    if (!vote) {
      return interaction.editReply(
        `Voting option ${i} is missing.`
      );
    }

    symbols.push(symbol);
    voteLabels.push(vote);
  }

  if (
    new Set(
      voteLabels.map(
        (x) => x.toLowerCase()
      )
    ).size !== 5
  ) {
    return interaction.editReply(
      "The five voting options must all be different."
    );
  }

  /*
   * Result labels are entered in ONE optional field,
   * separated with |.
   *
   * Example:
   * Married | Snogged | Smashed | Friend-zoned | Killed
   *
   * If left blank, the voting option names are used.
   */
  const resultText =
    clean(
      interaction.options.getString(
        "results"
      )
    );

  let resultLabels;

  if (resultText) {
    resultLabels =
      resultText
        .split("|")
        .map(clean)
        .filter(Boolean);

    if (resultLabels.length !== 5) {
      return interaction.editReply(
        "The Results field must contain exactly 5 names separated by |"
      );
    }
  } else {
    resultLabels =
      [...voteLabels];
  }

  const imageBuffers = [];

  try {
    for (
      const character
      of characters
    ) {
      imageBuffers.push(
        await downloadBuffer(
          character.url
        )
      );
    }
  } catch (error) {
    return interaction.editReply(
      `I couldn't process one of the images: ${error.message}`
    );
  }

  poll = {
    id: makeId(),

    duration:
      durationDays,

    startTime:
      Date.now(),

    endTime:
      Date.now() +
      durationDays *
      24 *
      60 *
      60 *
      1000,

    publicChannelId:
      interaction.channelId,

    publicMessageId:
      null,

    controlMessageId:
      null,

    baseImageMessageId:
      null,

    characters:
      characters.map(
        (character, index) => ({
          name:
            character.name,
          image:
            imageBuffers[index],
        })
      ),

    voteLabels,

    symbols,

    resultLabels,

    characterLeaders:
      [[], [], [], [], []],

    status:
      "active",
  };

  votes = new Map();
  selections = new Map();

  try {
    /*
     * Build and privately store the clean image.
     */
    baseImageBuffer =
      await buildBaseImage();

    await saveBaseImage();

    /*
     * Build the actual public results image.
     */
    const resultImage =
      await buildPollImage();

    const attachment =
      new AttachmentBuilder(
        resultImage,
        {
          name:
            "poll-results.jpg",
        }
      );

    /*
     * ONE public image.
     */
    publicPollMessage =
      await interaction.channel.send({
        files: [attachment],
      });

    poll.publicMessageId =
      publicPollMessage.id;

    /*
     * ONE clean control row.
     */
    const voteButton =
      new ButtonBuilder()
        .setCustomId("vote")
        .setLabel(
          "VOTE / CHANGE VOTE"
        )
        .setStyle(
          ButtonStyle.Primary
        );

    const confirmButton =
      new ButtonBuilder()
        .setCustomId("confirm")
        .setLabel(
          "CONFIRM VOTE"
        )
        .setStyle(
          ButtonStyle.Success
        );

    const row =
      new ActionRowBuilder()
        .addComponents(
          voteButton,
          confirmButton
        );

    controlMessage =
      await interaction.channel.send({
        components: [row],
      });

    poll.controlMessageId =
      controlMessage.id;

    await saveState();

    scheduleClose();

    /*
     * Remove the private "Poll created" reply.
     */
    await interaction.deleteReply();

  } catch (error) {
    console.error(error);

    poll = null;
    baseImageBuffer = null;

    await interaction.editReply(
      `Something went wrong: ${error.message}`
    );
  }
}

const pollCommand =
  new SlashCommandBuilder()
    .setName("poll")
    .setDescription(
      "Create a five-character poll"
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageGuild
    )
    .addStringOption(
      (option) =>
        option
          .setName("duration")
          .setDescription(
            "How long the poll runs"
          )
          .setRequired(true)
          .addChoices(
            {
              name: "1 day",
              value: "1d",
            },
            {
              name: "3 days",
              value: "3d",
            },
            {
              name: "7 days",
              value: "7d",
            },
            {
              name: "14 days",
              value: "14d",
            }
          )
    );

/*
 * 5 images
 */
for (let i = 1; i <= 5; i++) {
  pollCommand.addAttachmentOption(
    (option) =>
      option
        .setName(`image${i}`)
        .setDescription(
          `Picture ${i}`
        )
        .setRequired(true)
  );
}

/*
 * 5 character names
 */
for (let i = 1; i <= 5; i++) {
  pollCommand.addStringOption(
    (option) =>
      option
        .setName(`name${i}`)
        .setDescription(
          `Character ${i} name`
        )
        .setRequired(true)
  );
}

/*
 * 5 symbols
 */
for (let i = 1; i <= 5; i++) {
  pollCommand.addStringOption(
    (option) =>
      option
        .setName(`symbol${i}`)
        .setDescription(
          `Symbol for voting option ${i}`
        )
        .setRequired(true)
  );
}

/*
 * 5 voting option names
 */
for (let i = 1; i <= 5; i++) {
  pollCommand.addStringOption(
    (option) =>
      option
        .setName(`vote${i}`)
        .setDescription(
          `Voting option ${i}`
        )
        .setRequired(true)
  );
}

/*
 * ONE optional results field.
 *
 * Example:
 * Married | Snogged | Smashed | Friend-zoned | Killed
 */
pollCommand.addStringOption(
  (option) =>
    option
      .setName("results")
      .setDescription(
        "Optional: 5 result names separated by |"
      )
      .setRequired(false)
);

const endPollCommand =
  new SlashCommandBuilder()
    .setName("endpoll")
    .setDescription(
      "End the current poll"
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageGuild
    );

async function registerCommands() {
  const rest =
    new REST({
      version: "10",
    }).setToken(TOKEN);

  await rest.put(
    Routes.applicationCommands(
      client.user.id
    ),
    {
      body: [
        pollCommand.toJSON(),
        endPollCommand.toJSON(),
      ],
    }
  );
}

client.once("ready", async () => {
  console.log(
    `Logged in as ${client.user.tag}`
  );

  try {
    await registerCommands();

    console.log(
      "Slash commands registered."
    );

    await loadSavedPoll();

    console.log(
      "Startup complete."
    );

  } catch (error) {
    console.error(
      "Startup error:",
      error
    );
  }
});

client.on(
  "interactionCreate",
  async (interaction) => {
    try {

      if (
        interaction.isChatInputCommand()
      ) {

        if (
          interaction.commandName ===
          "poll"
        ) {
          await createPoll(
            interaction
          );

          return;
        }

        if (
          interaction.commandName ===
          "endpoll"
        ) {

          if (
            !poll ||
            poll.status !==
            "active"
          ) {
            return interaction.reply({
              content:
                "There is no active poll.",
              flags:
                MessageFlags.Ephemeral,
            });
          }

          await closePoll();

          return interaction.reply({
            content:
              "Poll ended.",
            flags:
              MessageFlags.Ephemeral,
          });
        }
      }

      if (
        interaction.isButton()
      ) {

        if (
          interaction.customId ===
          "vote"
        ) {
          await openVote(
            interaction
          );

          return;
        }

        if (
          interaction.customId ===
          "confirm"
        ) {
          await confirmVote(
            interaction
          );

          return;
        }
      }

      if (
        interaction.isStringSelectMenu()
      ) {

        if (
          interaction.customId.startsWith(
            "choice:"
          )
        ) {
          await handleChoice(
            interaction
          );
        }
      }

    } catch (error) {
      console.error(error);

      try {
        if (
          !interaction.replied &&
          !interaction.deferred
        ) {
          await interaction.reply({
            content:
              "Something went wrong.",
            flags:
              MessageFlags.Ephemeral,
          });
        }
      } catch {}
    }
  }
);

http
  .createServer(
    (req, res) => {
      res.writeHead(200, {
        "Content-Type":
          "text/plain",
      });

      res.end(
        "MayorBot is running."
      );
    }
  )
  .listen(
    PORT,
    () =>
      console.log(
        `Web server listening on ${PORT}`
      )
  );

client.login(TOKEN);
