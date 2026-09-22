const http = require('http');
const sharp = require('sharp');

const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
    AttachmentBuilder
} = require('discord.js');

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

const port = process.env.PORT || 3000;

http.createServer((req, res) => {
    res.writeHead(200);
    res.end('MayorBot is running.');
}).listen(port, () => {
    console.log(`Web server listening on port ${port}`);
});

const imageUrl =
    'https://raw.githubusercontent.com/TheMayorsDen/discord-smak-poll/main/smak_five_character_panel.png';

const characters = [
    { id: 'dante', name: 'DANTE' },
    { id: 'geralt', name: 'GERALT' },
    { id: 'snake', name: 'SNAKE' },
    { id: 'sephiroth', name: 'SEPHIROTH' },
    { id: 'zack', name: 'ZACK' }
];

const choices = [
    { value: 'friendzone', label: 'FRIEND-ZONE' },
    { value: 'snog', label: 'SNOG' },
    { value: 'smash', label: 'SMASH' },
    { value: 'marry', label: 'MARRY' },
    { value: 'kill', label: 'KILL' }
];

const selections = new Map();
const votes = new Map();

let pollMessage = null;

const commands = [
    new SlashCommandBuilder()
        .setName('poll')
        .setDescription('Create the S.M.A.K. poll')
].map(command => command.toJSON());

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);

    const rest = new REST({ version: '10' })
        .setToken(process.env.DISCORD_TOKEN);

    try {
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands }
        );

        console.log('Slash command registered successfully.');
    } catch (error) {
        console.error(error);
    }
});

client.on('interactionCreate', async interaction => {

    // /poll
    if (interaction.isChatInputCommand()) {

        if (interaction.commandName !== 'poll') return;

        try {
            await interaction.deferReply();

            votes.clear();
            selections.clear();

            const image = await createResultsImage();

            const castButton =
                new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('cast_vote')
                            .setLabel('CAST YOUR VOTE')
                            .setEmoji('🗳️')
                            .setStyle(ButtonStyle.Primary)
                    );

            const message =
                await interaction.editReply({
                    files: [
                        new AttachmentBuilder(image, {
                            name: 'smak-results.png'
                        })
                    ],
                    components: [castButton]
                });

            pollMessage = message;

        } catch (error) {
            console.error('Poll creation error:', error);

            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({
                    content: '❌ Something went wrong creating the poll.'
                }).catch(() => {});
            }
        }

        return;
    }

    // BUTTONS
    if (interaction.isButton()) {

        if (interaction.customId === 'cast_vote') {

            const userId = interaction.user.id;

            const current =
                selections.get(userId) || {};

            await interaction.reply({
                content:
                    'Choose one option for each character.',
                components:
                    buildVoteComponents(current),
                ephemeral: true
            });

            return;
        }

        if (interaction.customId === 'confirm_vote') {

            const userId = interaction.user.id;

            const current =
                selections.get(userId) || {};

            if (Object.keys(current).length !== 5) {

                await interaction.reply({
                    content:
                        '❌ Choose all five characters first.',
                    ephemeral: true
                });

                return;
            }

            if (
                new Set(
                    Object.values(current)
                ).size !== 5
            ) {

                await interaction.reply({
                    content:
                        '❌ Each option must be used exactly once.',
                    ephemeral: true
                });

                return;
            }

            votes.set(
                userId,
                { ...current }
            );

            await interaction.update({
                content:
                    '✅ Vote confirmed.',
                components: []
            });

            await updatePublicResults();

            return;
        }

        if (interaction.customId === 'change_choices') {

            const userId = interaction.user.id;

            const current =
                selections.get(userId) || {};

            await interaction.update({
                content:
                    'Choose one option for each character.',
                components:
                    buildVoteComponents(current)
            });

            return;
        }
    }

    // DROPDOWNS
    if (interaction.isStringSelectMenu()) {

        const userId = interaction.user.id;

        const characterId =
            interaction.customId.replace(
                'character_',
                ''
            );

        const selected =
            interaction.values[0];

        const current = {
            ...(selections.get(userId) || {})
        };

        current[characterId] = selected;

        selections.set(
            userId,
            current
        );

        await interaction.update({
            content:
                'Choose one option for each character.',
            components:
                buildVoteComponents(current)
        });
    }
});

// VOTING DROPDOWNS
function buildVoteComponents(current) {

    const used =
        new Set(
            Object.values(current)
        );

    const rows = [];

    for (const character of characters) {

        const selected =
            current[character.id];

        const available =
            choices.filter(choice =>
                !used.has(choice.value) ||
                choice.value === selected
            );

        const menu =
            new StringSelectMenuBuilder()
                .setCustomId(
                    `character_${character.id}`
                )
                .setPlaceholder(
                    selected
                        ? `${character.name} — ${choices.find(c => c.value === selected).label}`
                        : `${character.name} — Choose one`
                )
                .addOptions(
                    available.map(choice => ({
                        label: choice.label,
                        value: choice.value,
                        default:
                            choice.value === selected
                    }))
                );

        rows.push(
            new ActionRowBuilder()
                .addComponents(menu)
        );
    }

    const complete =
        Object.keys(current).length === 5 &&
        new Set(
            Object.values(current)
        ).size === 5;

    if (complete) {

        rows.pop();

        rows.push(
            new ActionRowBuilder()
                .addComponents(

                    new ButtonBuilder()
                        .setCustomId(
                            'change_choices'
                        )
                        .setLabel(
                            'CHANGE CHOICES'
                        )
                        .setEmoji('✏️')
                        .setStyle(
                            ButtonStyle.Secondary
                        ),

                    new ButtonBuilder()
                        .setCustomId(
                            'confirm_vote'
                        )
                        .setLabel(
                            'CONFIRM VOTE'
                        )
                        .setEmoji('✅')
                        .setStyle(
                            ButtonStyle.Success
                        )
                )
        );
    }

    return rows;
}

// CREATE RESULTS IMAGE
async function createResultsImage() {

    const response =
        await fetch(imageUrl);

    if (!response.ok) {
        throw new Error(
            `Could not download image: ${response.status}`
        );
    }

    const baseBuffer =
        Buffer.from(
            await response.arrayBuffer()
        );

    const counts = {};

    for (const choice of choices) {

        counts[choice.value] = {};

        for (const character of characters) {

            counts[choice.value][character.id] = 0;
        }
    }

    for (const vote of votes.values()) {

        for (const character of characters) {

            const choice =
                vote[character.id];

            if (
                choice &&
                counts[choice]
            ) {

                counts[choice][character.id]++;
            }
        }
    }

    const characterCenters = [
        192,
        576,
        960,
        1344,
        1728
    ];

    const positions =
        Array.from(
            { length: 5 },
            () => []
        );

    choices.forEach((choice, index) => {

        let winnerIndex = index;
        let highest = -1;

        characters.forEach(
            (character, characterIndex) => {

                const value =
                    counts[
                        choice.value
                    ][character.id];

                if (value > highest) {

                    highest = value;
                    winnerIndex =
                        characterIndex;
                }
            }
        );

        positions[winnerIndex].push({
            label:
                `${choice.label}  ${highest}`
        });
    });

    let labels = '';

    positions.forEach(
        (items, characterIndex) => {

            items.forEach(
                (item, stackIndex) => {

                    const x =
                        characterCenters[
                            characterIndex
                        ];

                    const y =
                        22 +
                        stackIndex * 54;

                    const width =
                        Math.max(
                            170,
                            item.label.length * 13 + 38
                        );

                    const left =
                        x - width / 2;

                    labels += `
                        <rect
                            x="${left}"
                            y="${y}"
                            width="${width}"
                            height="42"
                            rx="21"
                            fill="#111217"
                            fill-opacity="0.94"
                        />

                        <text
                            x="${x}"
                            y="${y + 28}"
                            text-anchor="middle"
                            font-family="Arial, sans-serif"
                            font-size="22"
                            font-weight="700"
                            fill="white"
                        >
                            ${escapeXml(item.label)}
                        </text>
                    `;
                }
            );
        }
    );

    const svg =
        Buffer.from(`
            <svg
                width="1920"
                height="1320"
                xmlns="http://www.w3.org/2000/svg"
            >
                <rect
                    width="1920"
                    height="1320"
                    fill="#14151b"
                />

                ${labels}

            </svg>
        `);

    return sharp(baseBuffer)
        .extend({
            top: 240,
            bottom: 0,
            left: 0,
            right: 0,
            background: '#14151b'
        })
        .composite([
            {
                input: svg,
                top: 0,
                left: 0
            }
        ])
        .png()
        .toBuffer();
}

function escapeXml(value) {

    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

async function updatePublicResults() {

    if (!pollMessage) return;

    try {

        const image =
            await createResultsImage();

        await pollMessage.edit({
            files: [
                new AttachmentBuilder(
                    image,
                    {
                        name:
                            'smak-results.png'
                    }
                )
            ]
        });

    } catch (error) {

        console.error(
            'Could not update results:',
            error
        );
    }
}

client.login(
    process.env.DISCORD_TOKEN
);
