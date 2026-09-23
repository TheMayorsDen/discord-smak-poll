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
let stateMessageId = null;
let baseImageMessageId = null;
let closeTimer = null;

function makeId() {
  return `${Date.now()}-${Math.floor(Math.random() * 1000000000)}`;
}

function clean(value) {
  return String(value || "").trim();
}

function cleanSymbol(value) {
  const text = clean(value);

  const markdown =
    text.match(/^\[([^\]]+)\]\([^)]+\)$/);

  return markdown ? markdown[1] : text;
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
    throw new Error(
      `Image download failed: ${response.status}`
    );
  }

  return Buffer.from(
    await response.arrayBuffer()
  );
}

async function getDataChannel() {
  return await client.channels.fetch(
    POLL_DATA_CHANNEL_ID
  );
}

async function getAllDataMessages() {
  const channel = await getDataChannel();

  const messages = [];
  let before;

  while (true) {
    const batch =
      await channel.messages.fetch({
        limit: 100,
        before,
      });

    if (!batch.size) {
      break;
    }

    messages.push(...batch.values());

    if (batch.size < 100) {
      break;
    }

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
    if (!vote.choices) {
      continue;
    }

    for (
      let character = 0;
      character < 5;
      character++
    ) {
      const option =
        vote.choices[character];

      if (
        option >= 0 &&
        option < 5
      ) {
        counts[option][character]++;
      }
    }
  }

  return counts;
}

function getCharacterLeaders(counts) {
  const leaders = [];

  for (
    let character = 0;
    character < 5;
    character++
  ) {
    let highest = 0;
    const winningOptions = [];

    for (
      let option = 0;
      option < 5;
      option++
    ) {
      const count =
        counts[option][character];

      if (count > highest) {
        highest = count;
        winningOptions.length = 0;
        winningOptions.push(option);
      } else if (
        count > 0 &&
        count === highest
      ) {
        winningOptions.push(option);
      }
    }

    leaders.push(winningOptions);
  }

  return leaders;
}

function textSize(text, width) {
  const length = text.length;

  if (length <= 12) {
    return Math.min(25, width / 8);
  }

  if (length <= 20) {
    return Math.min(20, width / 10);
  }

  if (length <= 30) {
    return Math.min(16, width / 12);
  }

  return Math.min(13, width / 15);
}

function buildOverlaySvg(
  counts,
  leaders
) {
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
   * TOP:
   * Winning category for each character.
   *
   * If categories are tied, all tied
   * categories are shown.
   */

  for (
    let character = 0;
    character < 5;
    character++
  ) {
    const winningOptions =
      leaders[character];

    if (!winningOptions.length) {
      continue;
    }

    const sectionX =
      character *
      (IMAGE_WIDTH + GAP);

    const availableWidth =
      IMAGE_WIDTH - 20;

    const badgeGap = 6;

    const badgeWidth =
      (
        availableWidth -
        badgeGap *
          (winningOptions.length - 1)
      ) /
      winningOptions.length;

    winningOptions.forEach(
      (option, index) => {
        const x =
          sectionX +
          10 +
          index *
            (badgeWidth + badgeGap);

        const label =
          poll.resultLabels[option];

        const fontSize =
          textSize(
            label,
            badgeWidth
          );

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
            ${escapeSvg(
              truncate(label, 35)
            )}
          </text>
        `;
      }
    );
  }

  /*
   * BOTTOM:
   * Five symbols and their total vote count.
   */

  const bottomY =
    TOP_HEIGHT +
    IMAGE_HEIGHT;

  const cellWidth =
    width / 5;

  for (
    let option = 0;
    option < 5;
    option++
  ) {
    const total =
      counts[option].reduce(
        (sum, value) =>
          sum + value,
        0
      );

    const centerX =
      cellWidth * option +
      cellWidth / 2;

    const symbol =
      cleanSymbol(
        poll.symbols[option]
      );

    svg += `
      <text
        x="${centerX - 18}"
        y="${bottomY + 58}"
        text-anchor="middle"
        dominant-baseline="middle"
        fill="white"
        font-family="Arial, Noto Color Emoji, Segoe UI Emoji, sans-serif"
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

  svg += "</svg>";

  return Buffer.from(svg);
}

async function buildBaseImage() {
  const width =
    IMAGE_WIDTH * 5 +
    GAP * 4;

  const height =
    TOP_HEIGHT +
    IMAGE_HEIGHT +
    BOTTOM_HEIGHT;

  const panels = [];

  for (
    const character of poll.characters
  ) {
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
      panels.map(
        (image, index) => ({
          input: image,
          left:
            index *
            (IMAGE_WIDTH + GAP),
          top: TOP_HEIGHT,
        })
      )
    )
    .jpeg({
      quality: 92,
    })
    .toBuffer();
}

async function buildPollImage() {
  const counts =
    getCounts();

  const leaders =
    getCharacterLeaders(
      counts
    );

  poll.characterLeaders =
    leaders;

  const overlay =
    buildOverlaySvg(
      counts,
      leaders
    );

  return await sharp(
    baseImageBuffer
  )
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
        name:
          "poll-base.jpg",
      }
    );

  const message =
    await channel.send({
      content:
        `POLL_BASE|${poll.id}`,
      files: [
        attachment,
      ],
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
      timestamp:
        Date.now(),
    })}`
  );
}

async function saveState() {
  if (!poll) {
    return;
  }

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
    schemaVersion: 5,

    pollId:
      poll.id,

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

    baseImageMessageId:
      poll.baseImageMessageId,

    characters:
      poll.characters.map(
        (character) => ({
          name:
            character.name,
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
      `POLL_STATE|${JSON.stringify(
        state
      )}`
    );

  stateMessageId =
    message.id;
}

/*
 * PUBLIC ROW 1
 *
 * Five character buttons.
 *
 * Discord allows a maximum of five
 * buttons in one action row, so these
 * are positioned horizontally across
 * the poll.
 */

function buildCharacterButtons(
  disabled = false
) {
  return new ActionRowBuilder()
    .addComponents(
      poll.characters.map(
        (
          character,
          index
        ) =>
          new ButtonBuilder()
            .setCustomId(
              `character:${index}`
            )
            .setLabel(
              truncate(
                character.name,
                20
              )
            )
            .setStyle(
              disabled
                ? ButtonStyle.Secondary
                : ButtonStyle.Primary
            )
            .setDisabled(
              disabled
            )
      )
    );
}

/*
 * PUBLIC ROW 2
 */

function buildConfirmRow(
  disabled = false
) {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(
          "confirm"
        )
        .setLabel(
          "CONFIRM VOTE"
        )
        .setStyle(
          ButtonStyle.Success
        )
        .setDisabled(
          disabled
        ),

      new ButtonBuilder()
        .setCustomId(
          "vote"
        )
        .setLabel(
          "CHANGE VOTE"
        )
        .setStyle(
          ButtonStyle.Secondary
        )
        .setDisabled(
          disabled
        )
    );
}

/*
 * PRIVATE CHARACTER BUTTONS
 *
 * These are shown to the voter after
 * clicking VOTE / CHANGE VOTE.
 */

function buildPrivateCharacterButtons(
  userId
) {
  const current =
    selections.get(
      userId
    ) ||
    Array(5).fill(null);

  return new ActionRowBuilder()
    .addComponents(
      poll.characters.map(
        (
          character,
          index
        ) =>
          new ButtonBuilder()
            .setCustomId(
              `private-character:${index}`
            )
            .setLabel(
              truncate(
                character.name,
                20
              )
            )
            .setStyle(
              current[index] === null
                ? ButtonStyle.Primary
                : ButtonStyle.Secondary
            )
      )
    );
}

/*
 * DROPDOWN FOR ONE CHARACTER
 */

function buildCharacterMenu(
  userId,
  characterIndex
) {
  const current =
    selections.get(
      userId
    ) ||
    Array(5).fill(null);

  const currentChoice =
    current[
      characterIndex
    ];

  /*
   * Categories already used by the
   * other four characters cannot be
   * selected here.
   */
  const usedByOthers =
    new Set(
      current.filter(
        (
          value,
          index
        ) =>
          value !== null &&
          index !==
            characterIndex
      )
    );

  const available =
    poll.voteLabels
      .map(
        (
          label,
          optionIndex
        ) => ({
          label,
          optionIndex,
        })
      )
      .filter(
        ({
          optionIndex,
        }) =>
          !usedByOthers.has(
            optionIndex
          ) ||
          optionIndex ===
            currentChoice
      );

  const menu =
    new StringSelectMenuBuilder()
      .setCustomId(
        `choice:${characterIndex}`
      )
      .setPlaceholder(
        currentChoice === null
          ? `Choose for ${truncate(
              poll.characters[
                characterIndex
              ].name,
              60
            )}`
          : `Current: ${truncate(
              poll.voteLabels[
                currentChoice
              ],
              70
            )}`
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
                String(
                  optionIndex
                )
              )
              .setDefault(
                currentChoice ===
                  optionIndex
              )
        )
      );

  return new ActionRowBuilder()
    .addComponents(
      menu
    );
}

/*
 * VOTE / CHANGE VOTE
 */

async function openVote(
  interaction
) {
  if (
    !poll ||
    poll.status !==
      "active"
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

  const current =
    selections.get(
      interaction.user.id
    );

  const assigned =
    current.filter(
      (value) =>
        value !== null
    ).length;

  return interaction.reply({
    content:
      `Your current vote: ${assigned}/5 characters assigned.\nClick a character button below to choose or change its category.`,

    components: [
      buildPrivateCharacterButtons(
        interaction.user.id
      ),
    ],

    flags:
      MessageFlags.Ephemeral,
  });
}

/*
 * OPEN ONE CHARACTER'S PRIVATE DROPDOWN
 */

async function openCharacterVote(
  interaction,
  characterIndex,
  privateWindow = false
) {
  if (
    !poll ||
    poll.status !==
      "active"
  ) {
    return interaction.reply({
      content:
        "This poll is closed.",
      flags:
        MessageFlags.Ephemeral,
    });
  }

  if (
    characterIndex < 0 ||
    characterIndex >= 5
  ) {
    return interaction.reply({
      content:
        "Invalid character.",
      flags:
        MessageFlags.Ephemeral,
    });
  }

  if (
    !selections.has(
      interaction.user.id
    )
  ) {
    const previous =
      votes.get(
        interaction.user.id
      );

    selections.set(
      interaction.user.id,
      previous
        ? [
            ...previous.choices,
          ]
        : Array(5).fill(null)
    );
  }

  const current =
    selections.get(
      interaction.user.id
    );

  const assigned =
    current.filter(
      (value) =>
        value !== null
    ).length;

  const components = [
    buildCharacterMenu(
      interaction.user.id,
      characterIndex
    ),
  ];

  if (privateWindow) {
    components.push(
      buildPrivateCharacterButtons(
        interaction.user.id
      )
    );
  }

  return interaction.reply({
    content:
      `${poll.characters[characterIndex].name}: ${
        current[characterIndex] === null
          ? "not chosen yet"
          : poll.voteLabels[
              current[
                characterIndex
              ]
            ]
      }\nAssigned: ${assigned}/5.`,

    components,

    flags:
      MessageFlags.Ephemeral,
  });
}

/*
 * CATEGORY SELECTED
 *
 * This only updates the private
 * voter interface. It does not post
 * anything publicly.
 */

async function handleChoice(
  interaction
) {
  if (
    !poll ||
    poll.status !==
      "active"
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

  if (
    characterIndex < 0 ||
    characterIndex >= 5 ||
    optionIndex < 0 ||
    optionIndex >= 5
  ) {
    return interaction.reply({
      content:
        "Invalid selection.",
      flags:
        MessageFlags.Ephemeral,
    });
  }

  const current =
    selections.get(
      interaction.user.id
    ) ||
    Array(5).fill(null);

  /*
   * Prevent duplicate categories.
   */
  for (
    let index = 0;
    index < 5;
    index++
  ) {
    if (
      index !== characterIndex &&
      current[index] ===
        optionIndex
    ) {
      return interaction.reply({
        content:
          "That category is already assigned to another character.",
        flags:
          MessageFlags.Ephemeral,
      });
    }
  }

  current[
    characterIndex
  ] = optionIndex;

  selections.set(
    interaction.user.id,
    [...current]
  );

  const assigned =
    current.filter(
      (value) =>
        value !== null
    ).length;

  await interaction.update({
    content:
      `${poll.characters[characterIndex].name}: ${poll.voteLabels[optionIndex]}\nAssigned: ${assigned}/5.`,

    components: [
      buildPrivateCharacterButtons(
        interaction.user.id
      ),
    ],
  });
}

/*
 * CONFIRM VOTE
 */

async function confirmVote(
  interaction
) {
  if (
    !poll ||
    poll.status !==
      "active"
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
      (value) =>
        value === null
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
    new Set(choices).size !==
    5
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
      choices: [
        ...choices,
      ],
      timestamp:
        Date.now(),
    }
  );

  await saveVote(
    interaction.user.id,
    choices
  );

  await updatePublicImage();

  await saveState();

  return interaction.reply({
    content:
      "Vote confirmed.",
    flags:
      MessageFlags.Ephemeral,
  });
}

/*
 * UPDATE THE ONE PUBLIC MESSAGE
 */

async function updatePublicImage() {
  if (
    !poll ||
    !publicPollMessage
  ) {
    return;
  }

  const image =
    await buildPollImage();

  const components =
    poll.status ===
    "active"
      ? [
          buildCharacterButtons(),
          buildConfirmRow(),
        ]
      : [
          buildCharacterButtons(
            true
          ),
        ];

  await publicPollMessage.edit({
    content:
      poll.status ===
      "active"
        ? null
        : "POLL CLOSED",

    attachments: [],

    files: [
      new AttachmentBuilder(
        image,
        {
          name:
            "poll-results.jpg",
        }
      ),
    ],

    components,
  });
}

/*
 * CLOSE POLL
 */

async function closePoll() {
  if (!poll) {
    return;
  }

  poll.status =
    "closed";

  if (closeTimer) {
    clearTimeout(
      closeTimer
    );

    closeTimer = null;
  }

  try {
    await updatePublicImage();
  } catch (error) {
    console.error(
      "Could not update closed poll:",
      error
    );
  }

  await saveState();

  selections.clear();
}

function scheduleClose() {
  if (!poll) {
    return;
  }

  if (closeTimer) {
    clearTimeout(
      closeTimer
    );
  }

  const remaining =
    poll.endTime -
    Date.now();

  if (remaining <= 0) {
    return closePoll();
  }

  closeTimer =
    setTimeout(
      closePoll,
      remaining
    );
}

/*
 * RESTORE ACTIVE POLL AFTER RESTART
 */

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

  if (
    !stateMessages.length
  ) {
    return;
  }

  let saved;

  try {
    saved =
      JSON.parse(
        stateMessages[0]
          .content.substring(
            "POLL_STATE|".length
          )
      );
  } catch {
    return;
  }

  /*
   * Only the new version 5
   * poll format is restored.
   */
  if (
    saved.schemaVersion !==
    5
  ) {
    return;
  }

  if (
    saved.status !==
    "active"
  ) {
    return;
  }

  if (
    saved.endTime <=
    Date.now()
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
   * Restore the clean base image.
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

  /*
   * Restore votes from the
   * private data channel.
   */

  votes = new Map();

  for (
    const message of messages
  ) {
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

/*
 * CREATE POLL
 */

async function createPoll(
  interaction
) {
  if (
    poll &&
    poll.status ===
      "active"
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

  /*
   * Get five pictures and
   * five character names.
   */

  for (
    let i = 1;
    i <= 5;
    i++
  ) {
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
      url:
        image.url,
    });
  }

  /*
   * Get five symbols and
   * five voting option names.
   */

  const voteLabels = [];
  const symbols = [];

  for (
    let i = 1;
    i <= 5;
    i++
  ) {
    const symbol =
      cleanSymbol(
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

    symbols.push(
      symbol
    );

    voteLabels.push(
      vote
    );
  }

  /*
   * Voting option names must
   * all be different.
   */

  if (
    new Set(
      voteLabels.map(
        (value) =>
          value.toLowerCase()
      )
    ).size !== 5
  ) {
    return interaction.editReply(
      "The five voting options must all be different."
    );
  }

  /*
   * Optional result labels.
   * If none is supplied, the
   * voting option name is used.
   */

  const resultLabels = [];

  for (
    let i = 1;
    i <= 5;
    i++
  ) {
    const result =
      clean(
        interaction.options.getString(
          `result${i}`
        )
      );

    resultLabels.push(
      result ||
        voteLabels[
          i - 1
        ]
    );
  }

  /*
   * Download all five images.
   */

  const imageBuffers = [];

  try {
    for (
      const character of
        characters
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

  /*
   * Create poll state.
   */

  poll = {
    id:
      makeId(),

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

    baseImageMessageId:
      null,

    characters:
      characters.map(
        (
          character,
          index
        ) => ({
          name:
            character.name,

          image:
            imageBuffers[
              index
            ],
        })
      ),

    voteLabels,

    symbols,

    resultLabels,

    characterLeaders:
      [
        [],
        [],
        [],
        [],
        [],
      ],

    status:
      "active",
  };

  votes =
    new Map();

  selections =
    new Map();

  try {
    /*
     * Create and store the
     * clean base image.
     */

    baseImageBuffer =
      await buildBaseImage();

    await saveBaseImage();

    /*
     * Build initial results image.
     */

    const resultImage =
      await buildPollImage();

    /*
     * ONE public Discord message.
     *
     * Image + character buttons +
     * confirm/change buttons.
     */

    publicPollMessage =
      await interaction.channel.send({
        files: [
          new AttachmentBuilder(
            resultImage,
            {
              name:
                "poll-results.jpg",
            }
          ),
        ],

        components: [
          buildCharacterButtons(),
          buildConfirmRow(),
        ],
      });

    poll.publicMessageId =
      publicPollMessage.id;

    await saveState();

    scheduleClose();

    /*
     * Remove the slash command's
     * temporary response.
     */

    await interaction.deleteReply();

  } catch (error) {
    console.error(
      error
    );

    poll = null;
    baseImageBuffer =
      null;

    await interaction.editReply(
      `Something went wrong: ${error.message}`
    );
  }
}

/*
 * /poll COMMAND
 */

const pollCommand =
  new SlashCommandBuilder()
    .setName(
      "poll"
    )
    .setDescription(
      "Create a five-character poll"
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageGuild
    )
    .addStringOption(
      (option) =>
        option
          .setName(
            "duration"
          )
          .setDescription(
            "How long the poll runs"
          )
          .setRequired(
            true
          )
          .addChoices(
            {
              name:
                "1 day",
              value:
                "1d",
            },
            {
              name:
                "3 days",
              value:
                "3d",
            },
            {
              name:
                "7 days",
              value:
                "7d",
            },
            {
              name:
                "14 days",
              value:
                "14d",
            }
          )
    );

/*
 * Five images.
 */

for (
  let i = 1;
  i <= 5;
  i++
) {
  pollCommand.addAttachmentOption(
    (option) =>
      option
        .setName(
          `image${i}`
        )
        .setDescription(
          `Picture ${i}`
        )
        .setRequired(
          true
        )
  );
}

/*
 * Five character names.
 */

for (
  let i = 1;
  i <= 5;
  i++
) {
  pollCommand.addStringOption(
    (option) =>
      option
        .setName(
          `name${i}`
        )
        .setDescription(
          `Character ${i} name`
        )
        .setRequired(
          true
        )
  );
}

/*
 * Five symbols.
 */

for (
  let i = 1;
  i <= 5;
  i++
) {
  pollCommand.addStringOption(
    (option) =>
      option
        .setName(
          `symbol${i}`
        )
        .setDescription(
          `Symbol for voting option ${i}`
        )
        .setRequired(
          true
        )
  );
}

/*
 * Five voting option names.
 */

for (
  let i = 1;
  i <= 5;
  i++
) {
  pollCommand.addStringOption(
    (option) =>
      option
        .setName(
          `vote${i}`
        )
        .setDescription(
          `Voting option ${i}`
        )
        .setRequired(
          true
        )
  );
}

/*
 * Five optional result names.
 */

for (
  let i = 1;
  i <= 5;
  i++
) {
  pollCommand.addStringOption(
    (option) =>
      option
        .setName(
          `result${i}`
        )
        .setDescription(
          `Optional result name ${i}`
        )
        .setRequired(
          false
        )
  );
}

/*
 * /endpoll COMMAND
 */

const endPollCommand =
  new SlashCommandBuilder()
    .setName(
      "endpoll"
    )
    .setDescription(
      "End the current poll"
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageGuild
    );

/*
 * REGISTER COMMANDS
 */

async function registerCommands() {
  const rest =
    new REST({
      version: "10",
    }).setToken(
      TOKEN
    );

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

/*
 * BOT READY
 */

client.once(
  "ready",
  async () => {
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
  }
);

/*
 * INTERACTIONS
 */

client.on(
  "interactionCreate",
  async (
    interaction
  ) => {
    try {

      /*
       * SLASH COMMANDS
       */

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

      /*
       * BUTTONS
       */

      if (
        interaction.isButton()
      ) {

        /*
         * CHANGE / START VOTE
         */

        if (
          interaction.customId ===
          "vote"
        ) {
          await openVote(
            interaction
          );

          return;
        }

        /*
         * CONFIRM
         */

        if (
          interaction.customId ===
          "confirm"
        ) {
          await confirmVote(
            interaction
          );

          return;
        }

        /*
         * PUBLIC CHARACTER BUTTON
         */

        if (
          interaction.customId.startsWith(
            "character:"
          )
        ) {
          await openCharacterVote(
            interaction,
            Number(
              interaction.customId
                .split(":")[1]
            ),
            false
          );

          return;
        }

        /*
         * PRIVATE CHARACTER BUTTON
         */

        if (
          interaction.customId.startsWith(
            "private-character:"
          )
        ) {
          await openCharacterVote(
            interaction,
            Number(
              interaction.customId
                .split(":")[1]
            ),
            true
          );

          return;
        }
      }

      /*
       * CATEGORY DROPDOWN
       */

      if (
        interaction.isStringSelectMenu() &&
        interaction.customId.startsWith(
          "choice:"
        )
      ) {
        await handleChoice(
          interaction
        );
      }

    } catch (error) {

      console.error(
        error
      );

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

/*
 * RENDER HEALTH SERVER
 */

http
  .createServer(
    (
      req,
      res
    ) => {
      res.writeHead(
        200,
        {
          "Content-Type":
            "text/plain",
        }
      );

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

/*
 * LOGIN
 */

client.login(
  TOKEN
);
