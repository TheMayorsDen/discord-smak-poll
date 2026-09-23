const http = require("http");
const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  PermissionsBitField,
  MessageFlags,
  REST,
  Routes
} = require("discord.js");
const sharp = require("sharp");

// ============================================================
// SETTINGS
// ============================================================

const TOKEN = process.env.DISCORD_TOKEN;
const DATA_CHANNEL_ID = process.env.POLL_DATA_CHANNEL_ID;
const PORT = process.env.PORT || 10000;

const DURATIONS = {
  "1d": 24 * 60 * 60 * 1000,
  "3d": 3 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "14d": 14 * 24 * 60 * 60 * 1000
};

const IMAGE_WIDTH = 420;
const IMAGE_HEIGHT = 720;
const RESULTS_HEIGHT = 155;

// ============================================================
// WEB SERVER
// ============================================================

http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/plain"
  });

  res.end("MayorBot is running.");
}).listen(PORT, () => {
  console.log(`Web server listening on port ${PORT}`);
});

// ============================================================
// DISCORD
// ============================================================

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// ============================================================
// CURRENT POLL
// ============================================================

let poll = null;
let votes = new Map();
let selections = new Map();

let baseImage = null;
let publicMessage = null;
let stateMessageId = null;
let closeTimer = null;

// ============================================================
// COMMAND
// ============================================================

const command = new SlashCommandBuilder()
  .setName("poll")
  .setDescription("Create a custom five-character poll")
  .setDefaultMemberPermissions(
    PermissionsBitField.Flags.ManageGuild
  )
  .setDMPermission(false)

  // DURATION
  .addStringOption(option =>
    option
      .setName("duration")
      .setDescription("How long the poll stays open")
      .setRequired(true)
      .addChoices(
        { name: "1 day", value: "1d" },
        { name: "3 days", value: "3d" },
        { name: "7 days", value: "7d" },
        { name: "14 days", value: "14d" }
      )
  )

  // CHARACTER IMAGES
  .addAttachmentOption(option =>
    option.setName("character1_image")
      .setDescription("Character 1 image")
      .setRequired(true)
  )
  .addAttachmentOption(option =>
    option.setName("character2_image")
      .setDescription("Character 2 image")
      .setRequired(true)
  )
  .addAttachmentOption(option =>
    option.setName("character3_image")
      .setDescription("Character 3 image")
      .setRequired(true)
  )
  .addAttachmentOption(option =>
    option.setName("character4_image")
      .setDescription("Character 4 image")
      .setRequired(true)
  )
  .addAttachmentOption(option =>
    option.setName("character5_image")
      .setDescription("Character 5 image")
      .setRequired(true)
  )

  // CHARACTER NAMES
  .addStringOption(option =>
    option.setName("character1_name")
      .setDescription("Name of character 1")
      .setRequired(true)
  )
  .addStringOption(option =>
    option.setName("character2_name")
      .setDescription("Name of character 2")
      .setRequired(true)
  )
  .addStringOption(option =>
    option.setName("character3_name")
      .setDescription("Name of character 3")
      .setRequired(true)
  )
  .addStringOption(option =>
    option.setName("character4_name")
      .setDescription("Name of character 4")
      .setRequired(true)
  )
  .addStringOption(option =>
    option.setName("character5_name")
      .setDescription("Name of character 5")
      .setRequired(true)
  )

  // VOTING OPTIONS
  .addStringOption(option =>
    option.setName("option1")
      .setDescription("Voting option 1")
      .setRequired(true)
  )
  .addStringOption(option =>
    option.setName("option2")
      .setDescription("Voting option 2")
      .setRequired(true)
  )
  .addStringOption(option =>
    option.setName("option3")
      .setDescription("Voting option 3")
      .setRequired(true)
  )
  .addStringOption(option =>
    option.setName("option4")
      .setDescription("Voting option 4")
      .setRequired(true)
  )
  .addStringOption(option =>
    option.setName("option5")
      .setDescription("Voting option 5")
      .setRequired(true)
  )

  // RANKING LABELS
  .addStringOption(option =>
    option.setName("ranking1")
      .setDescription("Result/ranking label 1")
      .setRequired(true)
  )
  .addStringOption(option =>
    option.setName("ranking2")
      .setDescription("Result/ranking label 2")
      .setRequired(true)
  )
  .addStringOption(option =>
    option.setName("ranking3")
      .setDescription("Result/ranking label 3")
      .setRequired(true)
  )
  .addStringOption(option =>
    option.setName("ranking4")
      .setDescription("Result/ranking label 4")
      .setRequired(true)
  )
  .addStringOption(option =>
    option.setName("ranking5")
      .setDescription("Result/ranking label 5")
      .setRequired(true)
  );

// ============================================================
// HELPERS
// ============================================================

function esc(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function getOptionValues(interaction, prefix) {
  return [1, 2, 3, 4, 5].map(i =>
    interaction.options.getString(
      `${prefix}${i}`,
      true
    )
  );
}

function getAttachments(interaction) {
  return [1, 2, 3, 4, 5].map(i =>
    interaction.options.getAttachment(
      `character${i}_image`,
      true
    )
  );
}

function validImage(attachment) {
  if (!attachment) return false;

  if (
    attachment.contentType &&
    attachment.contentType.startsWith("image/")
  ) {
    return true;
  }

  return /\.(png|jpg|jpeg|webp|gif)$/i.test(
    attachment.name || ""
  );
}

async function download(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Image download failed: ${response.status}`
    );
  }

  return Buffer.from(
    await response.arrayBuffer()
  );
}

// ============================================================
// CREATE LARGE FIVE-IMAGE PANEL
// ============================================================

async function createBaseImage(images) {
  const panels = [];

  for (const image of images) {
    panels.push(
      await sharp(image)
        .resize({
          width: IMAGE_WIDTH,
          height: IMAGE_HEIGHT,
          fit: "cover",
          position: "centre"
        })
        .jpeg({
          quality: 94
        })
        .toBuffer()
    );
  }

  return sharp({
    create: {
      width: IMAGE_WIDTH * 5,
      height: IMAGE_HEIGHT,
      channels: 3,
      background: "#101018"
    }
  })
    .composite(
      panels.map((image, index) => ({
        input: image,
        left: index * IMAGE_WIDTH,
        top: 0
      }))
    )
    .jpeg({
      quality: 94
    })
    .toBuffer();
}

// ============================================================
// COUNTS
// ============================================================

function getCounts() {
  const counts = Array.from(
    { length: 5 },
    () => Array(5).fill(0)
  );

  for (const choices of votes.values()) {
    for (let character = 0; character < 5; character++) {
      const option = choices[character];

      if (
        Number.isInteger(option) &&
        option >= 0 &&
        option < 5
      ) {
        counts[option][character]++;
      }
    }
  }

  return counts;
}

// ============================================================
// WINNERS
// ============================================================

function getWinners(counts) {
  const winners = [];

  for (let option = 0; option < 5; option++) {
    const row = counts[option];

    let best = 0;

    for (let character = 1; character < 5; character++) {
      if (row[character] > row[best]) {
        best = character;
      }
    }

    winners.push(best);
  }

  return winners;
}

// ============================================================
// RESULTS IMAGE
// ============================================================

function resultsSvg(counts, winners) {
  const width = IMAGE_WIDTH * 5;

  const placed = Array.from(
    { length: 5 },
    () => []
  );

  for (let option = 0; option < 5; option++) {
    placed[winners[option]].push(option);
  }

  let svg = `
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="${width}"
    height="${RESULTS_HEIGHT}"
  >
    <rect
      width="${width}"
      height="${RESULTS_HEIGHT}"
      fill="#111018"
    />
  `;

  for (let character = 0; character < 5; character++) {
    const options = placed[character];

    if (!options.length) continue;

    const center =
      character * IMAGE_WIDTH +
      IMAGE_WIDTH / 2;

    options.forEach((option, index) => {
      const y = 12 + index * 60;

      const label =
        poll.rankingLabels[option];

      const count =
        counts[option][character];

      const text =
        `${label}  ${count}`;

      svg += `
        <rect
          x="${character * IMAGE_WIDTH + 12}"
          y="${y}"
          width="${IMAGE_WIDTH - 24}"
          height="48"
          rx="12"
          fill="#20202b"
          stroke="#ffffff"
          stroke-opacity="0.25"
        />

        <text
          x="${center}"
          y="${y + 31}"
          text-anchor="middle"
          font-family="Arial, Helvetica, sans-serif"
          font-size="21"
          font-weight="700"
          fill="white"
        >
          ${esc(text)}
        </text>
      `;
    });
  }

  svg += "</svg>";

  return Buffer.from(svg);
}

async function createResultsImage() {
  const counts = getCounts();
  const winners = getWinners(counts);

  poll.winners = winners;

  const svg =
    resultsSvg(
      counts,
      winners
    );

  return sharp(baseImage)
    .extend({
      top: RESULTS_HEIGHT,
      bottom: 0,
      left: 0,
      right: 0,
      background: "#111018"
    })
    .composite([
      {
        input: svg,
        left: 0,
        top: 0
      }
    ])
    .jpeg({
      quality: 94
    })
    .toBuffer();
}

// ============================================================
// PUBLIC POLL
// ============================================================

function publicComponents(disabled = false) {
  return [
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId("open_vote")
          .setLabel(
            votes.size
              ? "VOTE / CHANGE VOTE"
              : "VOTE"
          )
          .setStyle(ButtonStyle.Primary)
          .setDisabled(disabled)
      )
  ];
}

// ============================================================
// PRIVATE VOTING PANEL
// ============================================================

function buildVotingRows(userId) {
  let choices =
    selections.get(userId);

  if (!choices) {
    choices = [
      null,
      null,
      null,
      null,
      null
    ];

    const previous =
      votes.get(userId);

    if (previous) {
      choices = [...previous];
    }

    selections.set(
      userId,
      choices
    );
  }

  return choices.map(
    (current, character) => {
      const menu =
        new StringSelectMenuBuilder()
          .setCustomId(
            `choose:${poll.id}:${character}`
          )
          .setPlaceholder(
            current === null
              ? `${poll.characters[character]} — choose`
              : `${poll.characters[character]} — ${poll.votingOptions[current]}`
          )
          .setMinValues(1)
          .setMaxValues(1);

      const available = [];

      for (let option = 0; option < 5; option++) {
        const alreadyUsed =
          choices.some(
            (value, index) =>
              index !== character &&
              value === option
          );

        if (
          !alreadyUsed ||
          option === current
        ) {
          available.push(option);
        }
      }

      menu.addOptions(
        available.map(option => ({
          label:
            poll.votingOptions[option]
              .substring(0, 100),

          value: String(option),

          default:
            option === current
        }))
      );

      return new ActionRowBuilder()
        .addComponents(menu);
    }
  );
}

function complete(choices) {
  if (!choices) return false;

  if (
    choices.length !== 5 ||
    choices.some(x => x === null)
  ) {
    return false;
  }

  return new Set(choices).size === 5;
}

// ============================================================
// CONFIRM BUTTON
// ============================================================

function confirmRow() {
  return [
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            `confirm:${poll.id}`
          )
          .setLabel("CONFIRM VOTE")
          .setStyle(ButtonStyle.Success)
      )
  ];
}

// ============================================================
// DATA CHANNEL
// ============================================================

async function dataChannel() {
  const channel =
    await client.channels.fetch(
      DATA_CHANNEL_ID
    );

  if (
    !channel ||
    !channel.isTextBased()
  ) {
    throw new Error(
      "MayorBot cannot access mayorbot-data."
    );
  }

  return channel;
}

async function saveBaseImage() {
  const channel =
    await dataChannel();

  const message =
    await channel.send({
      content:
        `IMAGE:${poll.id}`,
      files: [
        {
          attachment: baseImage,
          name: `poll-${poll.id}.jpg`
        }
      ]
    });

  poll.baseImageUrl =
    message.attachments.first().url;

  poll.baseMessageId =
    message.id;
}

async function saveVote(userId, choices) {
  const channel =
    await dataChannel();

  await channel.send({
    content:
      `VOTE:${JSON.stringify({
        pollId: poll.id,
        userId,
        choices,
        time: Date.now()
      })}`
  });
}

async function saveState() {
  const channel =
    await dataChannel();

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
    id: poll.id,
    status: poll.status,
    guildId: poll.guildId,
    channelId: poll.channelId,
    messageId: poll.messageId,
    endAt: poll.endAt,
    characters: poll.characters,
    votingOptions: poll.votingOptions,
    rankingLabels: poll.rankingLabels,
    baseImageUrl: poll.baseImageUrl,
    baseMessageId: poll.baseMessageId,
    winners: poll.winners
  };

  const message =
    await channel.send({
      content:
        `STATE:${JSON.stringify(state)}`
    });

  stateMessageId =
    message.id;
}

// ============================================================
// LOAD SAVED DATA
// ============================================================

async function loadPoll() {
  try {
    const channel =
      await dataChannel();

    const messages =
      await channel.messages.fetch({
        limit: 100
      });

    const stateMessages =
      [...messages.values()]
        .filter(m =>
          m.content.startsWith("STATE:")
        )
        .sort(
          (a, b) =>
            b.createdTimestamp -
            a.createdTimestamp
        );

    if (!stateMessages.length) {
      console.log("No saved poll.");
      return;
    }

    const state =
      JSON.parse(
        stateMessages[0]
          .content
          .substring(6)
      );

    if (state.status !== "active") {
      return;
    }

    poll = state;
    stateMessageId =
      stateMessages[0].id;

    baseImage =
      await download(
        poll.baseImageUrl
      );

    votes.clear();

    const voteMessages =
      [...messages.values()]
        .filter(m =>
          m.content.startsWith("VOTE:")
        )
        .sort(
          (a, b) =>
            a.createdTimestamp -
            b.createdTimestamp
        );

    for (const message of voteMessages) {
      try {
        const vote =
          JSON.parse(
            message.content.substring(5)
          );

        if (
          vote.pollId === poll.id
        ) {
          votes.set(
            vote.userId,
            vote.choices
          );
        }
      } catch {}
    }

    const channel2 =
      await client.channels.fetch(
        poll.channelId
      );

    publicMessage =
      await channel2.messages.fetch(
        poll.messageId
      );

    if (
      Date.now() >= poll.endAt
    ) {
      await closePoll();
      return;
    }

    scheduleClose();

    console.log(
      `Restored poll with ${votes.size} votes.`
    );

  } catch (error) {
    console.error(
      "Could not restore poll:",
      error
    );
  }
}

// ============================================================
// CLOSE
// ============================================================

function scheduleClose() {
  if (closeTimer) {
    clearTimeout(closeTimer);
  }

  if (!poll || poll.status !== "active") {
    return;
  }

  const remaining =
    poll.endAt - Date.now();

  if (remaining <= 0) {
    closePoll();
    return;
  }

  closeTimer =
    setTimeout(
      closePoll,
      Math.min(
        remaining,
        2147483647
      )
    );
}

async function closePoll() {
  if (!poll) return;

  poll.status = "closed";

  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }

  try {
    if (publicMessage) {
      const image =
        await createResultsImage();

      await publicMessage.edit({
        content:
          "🔒 **POLL CLOSED**",
        attachments: [],
        files: [
          {
            attachment: image,
            name: "final-results.jpg"
          }
        ],
        components:
          publicComponents(true)
      });
    }
  } catch (error) {
    console.error(
      "Could not close poll:",
      error
    );
  }

  await saveState();
}

// ============================================================
// CREATE POLL
// ============================================================

async function createPoll(interaction) {
  if (
    poll &&
    poll.status === "active" &&
    Date.now() < poll.endAt
  ) {
    throw new Error(
      "There is already an active poll."
    );
  }

  const duration =
    interaction.options.getString(
      "duration",
      true
    );

  const attachments =
    getAttachments(interaction);

  for (const attachment of attachments) {
    if (!validImage(attachment)) {
      throw new Error(
        "All five character files must be images."
      );
    }
  }

  const characters =
    getOptionValues(
      interaction,
      "character"
    );

  const votingOptions =
    getOptionValues(
      interaction,
      "option"
    );

  const rankingLabels =
    getOptionValues(
      interaction,
      "ranking"
    );

  const images = [];

  for (const attachment of attachments) {
    images.push(
      await download(
        attachment.url
      )
    );
  }

  baseImage =
    await createBaseImage(images);

  poll = {
    id:
      `${Date.now()}-${interaction.user.id}`,

    status: "active",

    guildId:
      interaction.guildId,

    channelId:
      interaction.channelId,

    messageId: null,

    endAt:
      Date.now() +
      DURATIONS[duration],

    duration,

    characters,

    votingOptions,

    rankingLabels,

    baseImageUrl: null,

    baseMessageId: null,

    winners: [
      0,
      1,
      2,
      3,
      4
    ]
  };

  votes.clear();
  selections.clear();

  await saveBaseImage();

  const image =
    await createResultsImage();

  publicMessage =
    await interaction.channel.send({
      files: [
        {
          attachment: image,
          name: "poll-results.jpg"
        }
      ],
      components:
        publicComponents(false)
    });

  poll.messageId =
    publicMessage.id;

  await saveState();

  scheduleClose();

  await interaction.editReply({
    content:
      "✅ Poll created."
  });
}

// ============================================================
// OPEN VOTING
// ============================================================

async function openVoting(interaction) {
  if (
    !poll ||
    poll.status !== "active"
  ) {
    return interaction.reply({
      content:
        "This poll is closed.",
      flags:
        MessageFlags.Ephemeral
    });
  }

  if (
    Date.now() >= poll.endAt
  ) {
    await closePoll();

    return interaction.reply({
      content:
        "This poll has closed.",
      flags:
        MessageFlags.Ephemeral
    });
  }

  const previous =
    votes.get(
      interaction.user.id
    );

  selections.set(
    interaction.user.id,
    previous
      ? [...previous]
      : [null, null, null, null, null]
  );

  await interaction.reply({
    content:
      "Choose one option for each character:",
    components:
      buildVotingRows(
        interaction.user.id
      ),
    flags:
      MessageFlags.Ephemeral
  });

  if (
    complete(
      selections.get(
        interaction.user.id
      )
    )
  ) {
    await interaction.followUp({
      content:
        "Your choices are complete.",
      components:
        confirmRow(),
      flags:
        MessageFlags.Ephemeral
    });
  }
}

// ============================================================
// SELECT
// ============================================================

async function handleSelect(interaction) {
  const parts =
    interaction.customId.split(":");

  const pollId = parts[1];
  const character =
    Number(parts[2]);

  if (
    !poll ||
    poll.id !== pollId ||
    poll.status !== "active"
  ) {
    return interaction.reply({
      content:
        "This poll is no longer active.",
      flags:
        MessageFlags.Ephemeral
    });
  }

  let choices =
    selections.get(
      interaction.user.id
    );

  if (!choices) {
    choices =
      [null, null, null, null, null];
  }

  const selected =
    Number(
      interaction.values[0]
    );

  // Remove the selected option
  // from any other character.
  for (let i = 0; i < 5; i++) {
    if (
      i !== character &&
      choices[i] === selected
    ) {
      choices[i] = null;
    }
  }

  choices[character] =
    selected;

  selections.set(
    interaction.user.id,
    choices
  );

  await interaction.update({
    components:
      buildVotingRows(
        interaction.user.id
      )
  });

  if (complete(choices)) {
    await interaction.followUp({
      content:
        "✅ All five choices are
