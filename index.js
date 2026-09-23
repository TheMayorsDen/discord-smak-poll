const http = require("http");
const path = require("path");
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
  Routes,
  REST
} = require("discord.js");
const sharp = require("sharp");

// ============================================================
// SETTINGS
// ============================================================

const TOKEN = process.env.DISCORD_TOKEN;
const DATA_CHANNEL_ID = process.env.POLL_DATA_CHANNEL_ID;
const PORT = process.env.PORT || 10000;

const CATEGORIES = [
  {
    key: "friend",
    label: "FRIEND-ZONE",
    emoji: "💙",
    color: "#4aa3ff"
  },
  {
    key: "snog",
    label: "SNOG",
    emoji: "😘",
    color: "#ff6fae"
  },
  {
    key: "smash",
    label: "SMASH",
    emoji: "🔥",
    color: "#ff6b35"
  },
  {
    key: "marry",
    label: "MARRY",
    emoji: "💍",
    color: "#d9a7ff"
  },
  {
    key: "kill",
    label: "KILL",
    emoji: "💀",
    color: "#777777"
  }
];

const DURATIONS = {
  "1d": {
    label: "1 day",
    ms: 24 * 60 * 60 * 1000
  },
  "3d": {
    label: "3 days",
    ms: 3 * 24 * 60 * 60 * 1000
  },
  "7d": {
    label: "7 days",
    ms: 7 * 24 * 60 * 60 * 1000
  },
  "14d": {
    label: "14 days",
    ms: 14 * 24 * 60 * 60 * 1000
  }
};

const RESULTS_TOP = 190;
const PANEL_WIDTH = 420;
const PANEL_HEIGHT = 720;

// ============================================================
// WEB SERVER FOR RENDER
// ============================================================

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/plain"
  });

  res.end("MayorBot is running.");
});

server.listen(PORT, () => {
  console.log(`Web server listening on port ${PORT}`);
});

// ============================================================
// DISCORD CLIENT
// ============================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds
  ]
});

// ============================================================
// POLL STATE
// ============================================================

let poll = null;
let votes = new Map();
let selections = new Map();
let baseImageBuffer = null;
let publicPollMessage = null;
let stateMessageId = null;
let closeTimer = null;

// ============================================================
// COMMAND
// ============================================================

const pollCommand = new SlashCommandBuilder()
  .setName("poll")
  .setDescription("Create a Friend-zone / Snog / Smash / Marry / Kill poll")
  .setDefaultMemberPermissions(
    PermissionsBitField.Flags.ManageGuild
  )
  .setDMPermission(false)

  .addStringOption(option =>
    option
      .setName("duration")
      .setDescription("How long the poll stays open")
      .setRequired(true)
      .addChoices(
        {
          name: "1 day",
          value: "1d"
        },
        {
          name: "3 days",
          value: "3d"
        },
        {
          name: "7 days",
          value: "7d"
        },
        {
          name: "14 days",
          value: "14d"
        }
      )
  )

  .addAttachmentOption(option =>
    option
      .setName("character1")
      .setDescription("First character image")
      .setRequired(true)
  )

  .addAttachmentOption(option =>
    option
      .setName("character2")
      .setDescription("Second character image")
      .setRequired(true)
  )

  .addAttachmentOption(option =>
    option
      .setName("character3")
      .setDescription("Third character image")
      .setRequired(true)
  )

  .addAttachmentOption(option =>
    option
      .setName("character4")
      .setDescription("Fourth character image")
      .setRequired(true)
  )

  .addAttachmentOption(option =>
    option
      .setName("character5")
      .setDescription("Fifth character image")
      .setRequired(true)
  );

// ============================================================
// HELPERS
// ============================================================

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function cleanCharacterName(filename) {
  const parsed = path.parse(filename);

  let name = parsed.name
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!name) {
    name = "CHARACTER";
  }

  return name
    .substring(0, 28)
    .toUpperCase();
}

function isImageAttachment(attachment) {
  if (!attachment) return false;

  if (
    attachment.contentType &&
    attachment.contentType.startsWith("image/")
  ) {
    return true;
  }

  const extension = path.extname(attachment.name || "").toLowerCase();

  return [
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".gif"
  ].includes(extension);
}

async function downloadBuffer(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Could not download image: HTTP ${response.status}`
    );
  }

  const arrayBuffer = await response.arrayBuffer();

  return Buffer.from(arrayBuffer);
}

// ============================================================
// IMAGE CREATION
// ============================================================

async function createBaseImage(images) {
  const resizedImages = [];

  for (const image of images) {
    const resized = await sharp(image)
      .resize({
        width: PANEL_WIDTH,
        height: PANEL_HEIGHT,
        fit: "cover",
        position: "centre"
      })
      .jpeg({
        quality: 92
      })
      .toBuffer();

    resizedImages.push(resized);
  }

  const composite = resizedImages.map((buffer, index) => ({
    input: buffer,
    left: index * PANEL_WIDTH,
    top: 0
  }));

  const width = PANEL_WIDTH * 5;

  return sharp({
    create: {
      width,
      height: PANEL_HEIGHT,
      channels: 3,
      background: {
        r: 10,
        g: 10,
        b: 14
      }
    }
  })
    .composite(composite)
    .jpeg({
      quality: 92
    })
    .toBuffer();
}

function calculateCounts() {
  const counts = CATEGORIES.map(() =>
    Array(5).fill(0)
  );

  for (const choices of votes.values()) {
    if (!Array.isArray(choices)) continue;

    for (let character = 0; character < 5; character++) {
      const category = choices[character];

      if (
        Number.isInteger(category) &&
        category >= 0 &&
        category < 5
      ) {
        counts[category][character]++;
      }
    }
  }

  return counts;
}

function calculateWinners(counts, previousWinners = null) {
  const winners = [];

  for (let category = 0; category < 5; category++) {
    const row = counts[category];

    const highest = Math.max(...row);

    const tied = [];

    for (let character = 0; character < 5; character++) {
      if (row[character] === highest) {
        tied.push(character);
      }
    }

    // Keep the previous winner during a tie.
    if (
      previousWinners &&
      tied.includes(previousWinners[category])
    ) {
      winners.push(previousWinners[category]);
      continue;
    }

    // At the start, spread the five categories across
    // the five characters rather than putting everything
    // over character one.
    if (highest === 0) {
      winners.push(category);
      continue;
    }

    winners.push(tied[0]);
  }

  return winners;
}

function createResultsSvg(width, winners, counts) {
  const positions = [
    [],
    [],
    [],
    [],
    []
  ];

  for (let category = 0; category < 5; category++) {
    const character = winners[category];

    positions[character].push(category);
  }

  let svg = `
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="${width}"
      height="${RESULTS_TOP}"
    >
      <rect
        x="0"
        y="0"
        width="${width}"
        height="${RESULTS_TOP}"
        fill="#121019"
      />
  `;

  for (let character = 0; character < 5; character++) {
    const categoriesHere = positions[character];

    if (categoriesHere.length === 0) {
      continue;
    }

    const centerX =
      character * PANEL_WIDTH +
      PANEL_WIDTH / 2;

    const badgeWidth = Math.min(
      PANEL_WIDTH - 20,
      390
    );

    const badgeX =
      centerX - badgeWidth / 2;

    categoriesHere.forEach((category, stackIndex) => {
      const y = 10 + stackIndex * 55;

      const categoryData = CATEGORIES[category];

      const count =
        counts[category][character];

      svg += `
        <g>
          <rect
            x="${badgeX}"
            y="${y}"
            width="${badgeWidth}"
            height="45"
            rx="12"
            fill="${categoryData.color}"
            fill-opacity="0.96"
          />

          <text
            x="${centerX}"
            y="${y + 30}"
            text-anchor="middle"
            font-family="Arial, Helvetica, sans-serif"
            font-size="21"
            font-weight="700"
            fill="#ffffff"
          >
            ${escapeXml(
              `${categoryData.emoji} ${categoryData.label}  ${count}`
            )}
          </text>
        </g>
      `;
    });
  }

  svg += `
    </svg>
  `;

  return Buffer.from(svg);
}

async function createResultsImage() {
  if (!baseImageBuffer) {
    throw new Error("Base image is not loaded.");
  }

  const metadata = await sharp(
    baseImageBuffer
  ).metadata();

  const width = metadata.width;

  const counts = calculateCounts();

  const winners = calculateWinners(
    counts,
    poll.winners
  );

  poll.winners = winners;

  const svg = createResultsSvg(
    width,
    winners,
    counts
  );

  return sharp(baseImageBuffer)
    .extend({
      top: RESULTS_TOP,
      bottom: 0,
      left: 0,
      right: 0,
      background: {
        r: 18,
        g: 16,
        b: 25
      }
    })
    .composite([
      {
        input: svg,
        left: 0,
        top: 0
      }
    ])
    .jpeg({
      quality: 92
    })
    .toBuffer();
}

// ============================================================
// PUBLIC POLL BUTTON
// ============================================================

function buildPublicComponents(disabled = false) {
  const button = new ButtonBuilder()
    .setCustomId("poll_vote")
    .setLabel("VOTE / CHANGE VOTE")
    .setStyle(ButtonStyle.Primary)
    .setDisabled(disabled);

  return [
    new ActionRowBuilder()
      .addComponents(button)
  ];
}

// ============================================================
// PRIVATE VOTING DROPDOWNS
// ============================================================

function buildVotingComponents(userId) {
  let choices = selections.get(userId);

  if (!choices) {
    choices = [null, null, null, null, null];

    const previousVote = votes.get(userId);

    if (previousVote) {
      choices = [...previousVote];
    }

    selections.set(userId, choices);
  }

  const rows = [];

  for (let character = 0; character < 5; character++) {
    const currentChoice = choices[character];

    const availableCategories = [];

    for (let category = 0; category < 5; category++) {
      const alreadyUsedElsewhere =
        choices.some(
          (value, otherCharacter) =>
            otherCharacter !== character &&
            value === category
        );

      if (
        !alreadyUsedElsewhere ||
        currentChoice === category
      ) {
        availableCategories.push(category);
      }
    }

    const menu = new StringSelectMenuBuilder()
      .setCustomId(
        `poll_pick:${poll.id}:${character}`
      )
      .setPlaceholder(
        currentChoice === null
          ? `${poll.characters[character]} — choose`
          : `${poll.characters[character]} — ${CATEGORIES[currentChoice].label}`
      )
      .setMinValues(1)
      .setMaxValues(1);

    menu.addOptions(
      availableCategories.map(category => ({
        label: CATEGORIES[category].label,
        value: String(category),
        description: `${CATEGORIES[category].emoji} ${CATEGORIES[category].label}`,
        emoji: CATEGORIES[category].emoji,
        default: currentChoice === category
      }))
    );

    rows.push(
      new ActionRowBuilder()
        .addComponents(menu)
    );
  }

  return rows;
}

function isCompleteVote(choices) {
  if (!Array.isArray(choices)) {
    return false;
  }

  if (choices.length !== 5) {
    return false;
  }

  if (choices.some(value => value === null)) {
    return false;
  }

  const unique = new Set(choices);

  return unique.size === 5;
}

function buildConfirmComponents() {
  const confirm = new ButtonBuilder()
    .setCustomId(
      `poll_confirm:${poll.id}`
    )
    .setLabel("CONFIRM VOTE")
    .setStyle(ButtonStyle.Success);

  return [
    new ActionRowBuilder()
      .addComponents(confirm)
  ];
}

// ============================================================
// DATA CHANNEL STORAGE
// ============================================================

async function getDataChannel() {
  if (!DATA_CHANNEL_ID) {
    throw new Error(
      "POLL_DATA_CHANNEL_ID is not set."
    );
  }

  const channel =
    await client.channels.fetch(
      DATA_CHANNEL_ID
    );

  if (!channel || !channel.isTextBased()) {
    throw new Error(
      "MayorBot data channel could not be found."
    );
  }

  return channel;
}

async function saveBaseImage() {
  const dataChannel = await getDataChannel();

  const message = await dataChannel.send({
    content:
      `POLL_BASE|${poll.id}|${poll.characters.join(" | ")}`,
    files: [
      {
        attachment: baseImageBuffer,
        name: `poll-base-${poll.id}.jpg`
      }
    ]
  });

  const attachment =
    message.attachments.first();

  if (!attachment) {
    throw new Error(
      "Could not save the poll base image."
    );
  }

  poll.baseImageUrl = attachment.url;
  poll.baseMessageId = message.id;

  return message;
}

async function saveState() {
  const dataChannel =
    await getDataChannel();

  if (stateMessageId) {
    try {
      const oldState =
        await dataChannel.messages.fetch(
          stateMessageId
        );

      await oldState.delete();
    } catch (error) {
      // State message may already be gone.
    }
  }

  const state = {
    type: "state",
    id: poll.id,
    status: poll.status,
    guildId: poll.guildId,
    channelId: poll.channelId,
    messageId: poll.messageId,
    endAt: poll.endAt,
    duration: poll.duration,
    characters: poll.characters,
    baseImageUrl: poll.baseImageUrl,
    baseMessageId: poll.baseMessageId,
    winners: poll.winners,
    updatedAt: Date.now()
  };

  const message =
    await dataChannel.send({
      content:
        `POLL_STATE:${JSON.stringify(state)}`
    });

  stateMessageId = message.id;
}

async function saveVote(userId, choices) {
  const dataChannel =
    await getDataChannel();

  const record = {
    type: "vote",
    pollId: poll.id,
    userId,
    choices,
    timestamp: Date.now()
  };

  await dataChannel.send({
    content:
      `VOTE:${JSON.stringify(record)}`
  });
}

async function fetchAllDataMessages(channel) {
  const messages = [];
  let before;

  while (true) {
    const batch =
      await channel.messages.fetch({
        limit: 100,
        ...(before ? { before } : {})
      });

    if (batch.size === 0) {
      break;
    }

    messages.push(
      ...batch.values()
    );

    if (batch.size < 100) {
      break;
    }

    before =
      batch.last().id;
  }

  return messages;
}

async function loadSavedPoll() {
  try {
    const dataChannel =
      await getDataChannel();

    const messages =
      await fetchAllDataMessages(
        dataChannel
      );

    const stateMessages = messages
      .filter(message =>
        message.content.startsWith(
          "POLL_STATE:"
        )
      )
      .sort(
        (a, b) =>
          b.createdTimestamp -
          a.createdTimestamp
      );

    if (stateMessages.length === 0) {
      console.log(
        "No saved poll found."
      );
      return;
    }

    let savedState = null;

    for (const message of stateMessages) {
      try {
        const parsed =
          JSON.parse(
            message.content.substring(
              "POLL_STATE:".length
            )
          );

        if (
          parsed &&
          parsed.status === "active"
        ) {
          savedState = parsed;
          stateMessageId = message.id;
          break;
        }
      } catch (error) {
        // Ignore malformed state records.
      }
    }

    if (!savedState) {
      console.log(
        "No active saved poll found."
      );
      return;
    }

    poll = savedState;

    votes.clear();

    const voteMessages = messages
      .filter(message =>
        message.content.startsWith("VOTE:")
      )
      .sort(
        (a, b) =>
          a.createdTimestamp -
          b.createdTimestamp
      );

    for (const message of voteMessages) {
      try {
        const record =
          JSON.parse(
            message.content.substring(
              "VOTE:".length
            )
          );

        if (
          record.pollId === poll.id &&
          Array.isArray(record.choices)
        ) {
          votes.set(
            record.userId,
            record.choices
          );
        }
      } catch (error) {
        // Ignore malformed vote records.
      }
    }

    if (
      poll.baseImageUrl
    ) {
      baseImageBuffer =
        await downloadBuffer(
          poll.baseImageUrl
        );
    }

    try {
      const channel =
        await client.channels.fetch(
          poll.channelId
        );

      if (
        channel &&
        channel.isTextBased()
      ) {
        publicPollMessage =
          await channel.messages.fetch(
            poll.messageId
          );
      }
    } catch (error) {
      console.error(
        "Could not fetch saved public poll message:",
        error
      );
    }

    if (
      !publicPollMessage
    ) {
      console.log(
        "Saved poll message could not be found."
      );
      return;
    }

    if (
      Date.now() >= poll.endAt
    ) {
      await closePoll();
      return;
    }

    schedulePollClose();

    console.log(
      `Restored poll ${poll.id} with ${votes.size} votes.`
    );
  } catch (error) {
    console.error(
      "Could not load saved poll:",
      error
    );
  }
}

// ============================================================
// POLL CLOSING
// ============================================================

function schedulePollClose() {
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

  // Node timers have a maximum delay.
  // This also keeps longer polls safe.
  const MAX_TIMER =
    24 * 60 * 60 * 1000;

  closeTimer = setTimeout(
    schedulePollClose,
    Math.min(remaining, MAX_TIMER)
  );

  if (remaining <= MAX_TIMER) {
    closeTimer = setTimeout(
      () => closePoll(),
      remaining
    );
  }
}

async function closePoll() {
  if (!poll) {
    return;
  }

  if (poll.status === "closed") {
    return;
  }

  poll.status = "closed";

  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }

  try {
    if (publicPollMessage) {
      await publicPollMessage.edit({
        content:
          "🔒 **POLL CLOSED**",
        components:
          buildPublicComponents(true)
      });
    }
  } catch (error) {
    console.error(
      "Could not close public poll message:",
      error
    );
  }

  try {
    await saveState();
  } catch (error) {
    console.error(
      "Could not save closed poll state:",
      error
    );
  }

  console.log(
    `Poll ${poll.id} closed.`
  );
}

// ============================================================
// CREATE POLL
// ============================================================

async function createPoll(interaction) {
  const durationKey =
    interaction.options.getString(
      "duration",
      true
    );

  const duration =
    DURATIONS[durationKey];

  if (!duration) {
    throw new Error(
      "Invalid poll duration."
    );
  }

  const attachments = [];

  for (let i = 1; i <= 5; i++) {
    const attachment =
      interaction.options.getAttachment(
        `character${i}`,
        true
      );

    if (!isImageAttachment(attachment)) {
      throw new Error(
        `Character ${i} is not an image.`
      );
    }

    attachments.push(attachment);
  }

  const characters =
    attachments.map(
      attachment =>
        cleanCharacterName(
          attachment.name
        )
    );

  const imageBuffers = [];

  for (const attachment of attachments) {
    imageBuffers.push(
      await downloadBuffer(
        attachment.url
      )
    );
  }

  baseImageBuffer =
    await createBaseImage(
      imageBuffers
    );

  const pollId =
    `${Date.now()}-${interaction.user.id}`;

  poll = {
    type: "state",
    id: pollId,
    status: "active",
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    messageId: null,
    endAt:
      Date.now() + duration.ms,
    duration: durationKey,
    durationLabel: duration.label,
    characters,
    baseImageUrl: null,
    baseMessageId: null,
    winners: [0, 1, 2, 3, 4]
  };

  votes.clear();
  selections.clear();

  // Save the base image in the private data channel.
  await saveBaseImage();

  const resultsImage =
    await createResultsImage();

  publicPollMessage =
    await interaction.channel.send({
      content: "",
      files: [
        {
          attachment: resultsImage,
          name: "poll-results.jpg"
        }
      ],
      components:
        buildPublicComponents(false)
    });

  poll.messageId =
    publicPollMessage.id;

  await saveState();

  schedulePollClose();

  await interaction.editReply({
    content:
      `✅ Poll created — open for **${duration.label}**.`
  });
}

// ============================================================
// OPEN PRIVATE VOTING PANEL
// ============================================================

async function openVotingPanel(interaction) {
  if (
    !poll ||
    poll.status !== "active"
  ) {
    await interaction.reply({
      content:
        "This poll is closed.",
      flags: MessageFlags.Ephemeral
    });

    return;
  }

  if (
    Date.now() >= poll.endAt
  ) {
    await closePoll();

    await interaction.reply({
      content:
        "This poll has closed.",
      flags: MessageFlags.Ephemeral
    });

    return;
  }

  const userId =
    interaction.user.id;

  const previousVote =
    votes.get(userId);

  if (previousVote) {
    selections.set(
      userId,
      [...previousVote]
    );
  } else {
    selections.set(
      userId,
      [null, null, null, null, null]
    );
  }

  await interaction.reply({
    content:
      "**Make your choices.**\n\nEach category can only be used once. Your choices are private until you confirm.",
    files: [
      {
        attachment: baseImageBuffer,
        name: "poll-vote.jpg"
      }
    ],
    components:
      buildVotingComponents(userId),
    flags: MessageFlags.Ephemeral
  });

  if (
    isCompleteVote(
      selections.get(userId)
    )
  ) {
    await interaction.followUp({
      content:
        "Your current selections are complete.",
      components:
        buildConfirmComponents(),
      flags: MessageFlags.Ephemeral
    });
  }
}

// ============================================================
// HANDLE CHARACTER SELECTION
// ============================================================

async function handleSelection(interaction) {
  if (
    !poll ||
    poll.status !== "active"
  ) {
    await interaction.reply({
      content:
        "This poll is closed.",
      flags: MessageFlags.Ephemeral
    });

    return;
  }

  const parts =
    interaction.customId.split(":");

  const pollId = parts[1];
  const character =
    Number(parts[2]);

  if (pollId !== poll.id) {
    await interaction.reply({
      content:
        "This voting panel belongs to an older poll.",
      flags: MessageFlags.Ephemeral
    });

    return;
  }

  if (
    !Number.isInteger(character) ||
    character < 0 ||
    character > 4
  ) {
    await interaction.reply({
      content:
        "Invalid character selection.",
      flags: MessageFlags.Ephemeral
    });

    return;
  }

  const selectedCategory =
    Number(
      interaction.values[0]
    );

  if (
    !Number.isInteger(
      selectedCategory
    )
  ) {
    await interaction.reply({
      content:
        "Invalid category selection.",
      flags: MessageFlags.Ephemeral
    });

    return;
  }

  let choices =
    selections.get(
      interaction.user.id
    );

  if (!choices) {
    choices = [
      null,
      null,
      null,
      null,
      null
    ];
  }

  // Remove this category from another character
  // if it was already selected there.
  for (
    let i = 0;
    i < choices.length;
    i++
  ) {
    if (
      i !== character &&
      choices[i] === selectedCategory
    ) {
      choices[i] = null;
    }
  }

  choices[character] =
    selectedCategory;

  selections.set(
    interaction.user.id,
    choices
  );

  const complete =
    isCompleteVote(choices);

  await interaction.update({
    components:
      buildVotingComponents(
        interaction.user.id
      )
  });

  if (complete) {
    await interaction.followUp({
      content:
        "✅ All five choices are selected. When you're happy with them, confirm your vote below.",
      components:
        buildConfirmComponents(),
      flags: MessageFlags.Ephemeral
    });
  }
}

// ============================================================
// CONFIRM VOTE
// ============================================================

async function confirmVote(interaction) {
  if (
    !poll ||
    poll.status !== "active"
  ) {
    await interaction.reply({
      content:
        "This poll is closed.",
      flags: MessageFlags.Ephemeral
    });

    return;
  }

  const userId =
    interaction.user.id;

  const choices =
    selections.get(userId);

  if (!isCompleteVote(choices)) {
    await interaction.reply({
      content:
        "You must assign all five categories exactly once before confirming.",
      flags: MessageFlags.Ephemeral
    });

    return;
  }

  // Save the vote first.
  await saveVote(
    userId,
    [...choices]
  );

  votes.set(
    userId,
    [...choices]
  );

  const counts =
    calculateCounts();

  poll.winners =
    calculateWinners(
      counts,
      poll.winners
    );

  const resultsImage =
    await createResultsImage();

  if (publicPollMessage) {
    await publicPollMessage.edit({
      attachments: [],
      files: [
        {
          attachment: resultsImage,
          name: "poll-results.jpg"
        }
      ],
      components:
        buildPublicComponents(false)
    });
  }

  await saveState();

  await interaction.update({
    content:
      "✅ **Vote confirmed.**",
    components: []
  });

  console.log(
    `Vote confirmed by ${interaction.user.tag}`
  );
}

// ============================================================
// DISCORD EVENTS
// ============================================================

client.once("ready", async () => {
  console.log(
    `Logged in as ${client.user.tag}`
  );

  try {
    const rest =
      new REST({ version: "10" })
        .setToken(TOKEN);

    await rest.put(
      Routes.applicationCommands(
        client.user.id
      ),
      {
        body: [
          pollCommand.toJSON()
        ]
      }
    );

    console.log(
      "Slash command registered successfully."
    );
  } catch (error) {
    console.error(
      "Could not register slash command:",
      error
    );
  }

  await loadSavedPoll();
});

client.on(
  "interactionCreate",
  async interaction => {
    try {
      if (
        interaction.isChatInputCommand()
      ) {
        if (
          interaction.commandName ===
          "poll"
        ) {
          if (
            poll &&
            poll.status === "active" &&
            Date.now() < poll.endAt
          ) {
            await interaction.reply({
              content:
                "There is already an active poll. Wait for it to finish before creating another.",
              flags: MessageFlags.Ephemeral
            });

            return;
          }

          await interaction.deferReply({
            flags: MessageFlags.Ephemeral
          });

          await createPoll(
            interaction
          );

          return;
        }
      }

      if (
        interaction.isButton()
      ) {
        if (
          interaction.customId ===
          "poll_vote"
        ) {
          await openVotingPanel(
            interaction
          );

          return;
        }

        if (
          interaction.customId.startsWith(
            "poll_confirm:"
          )
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
            "poll_pick:"
          )
        ) {
          await handleSelection(
            interaction
          );

          return;
        }
      }
    } catch (error) {
      console.error(
        "Interaction error:",
        error
      );

      try {
        if (
          interaction.replied ||
          interaction.deferred
        ) {
          await interaction.followUp({
            content:
              "Something went wrong. Check the bot logs.",
            flags: MessageFlags.Ephemeral
          });
        } else {
          await interaction.reply({
            content:
              "Something went wrong. Check the bot logs.",
            flags: MessageFlags.Ephemeral
          });
        }
      } catch (replyError) {
        console.error(
          "Could not send error reply:",
          replyError
        );
      }
    }
  }
);

// ============================================================
// LOGIN
// ============================================================

if (!TOKEN) {
  console.error(
    "DISCORD_TOKEN environment variable is missing."
  );
  process.exit(1);
}

if (!DATA_CHANNEL_ID) {
  console.error(
    "POLL_DATA_CHANNEL_ID environment variable is missing."
  );
  process.exit(1);
}

client.login(TOKEN);
