const http = require('http');

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
    EmbedBuilder
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

// -------------------------
// POLL
// -------------------------

const imageUrl =
    'https://raw.githubusercontent.com/TheMayorsDen/discord-smak-poll/main/smak_five_character_panel.png';

const characters = [
    { id: 'dante', name: 'DANTE' },
    { id: 'geralt', name: 'GERALT' },
    { id: 'snake', name: 'SNAKE' },
    { id: 'sephiroth', name: 'SEPHIROTH' },
    { id: 'zack', name: 'ZACK' }
];

const choices = {
    friendzone: '💙 FRIEND-ZONE',
    snog: '😘 SNOG',
    smash: '🔥 SMASH',
    marry: '💍 MARRY',
    kill: '💀 KILL'
};

const choiceEmoji = {
    friendzone: '💙',
    snog: '😘',
    smash: '🔥',
    marry: '💍',
    kill: '💀'
};

// Temporary selections while users are voting
const selections = new Map();

// Completed votes
const votes = new Map();

// The Discord message containing the poll
let pollMessage = null;

// -------------------------
// COMMAND
// -------------------------

const commands = [
    new SlashCommandBuilder()
        .setName('poll')
        .setDescription('Create the S.M.A.K. poll')
].map(command => command.toJSON());

// -------------------------
// READY
// -------------------------

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

// -------------------------
// CREATE POLL
// -------------------------

client.on('interactionCreate', async interaction => {

    if (interaction.isChatInputCommand()) {

        if (interaction.commandName !== 'poll') return;

        const embed = createPollEmbed();

        const components = createPollComponents();

        const message = await interaction.reply({
            embeds: [embed],
            components,
            fetchReply: true
        });

        pollMessage = message;

        return;
    }

    // -------------------------
    // DROPDOWN
    // -------------------------

    if (interaction.isStringSelectMenu()) {

        const userId = interaction.user.id;

        const characterId =
            interaction.customId.replace('character_', '');

        const selectedChoice =
            interaction.values[0];

        let userSelections =
            selections.get(userId) || {};

        // Check duplicate choice
        const duplicate = Object.entries(userSelections)
            .find(([character, choice]) =>
                character !== characterId &&
                choice === selectedChoice
            );

        if (duplicate) {

            await interaction.deferUpdate();

            return;
        }

        userSelections[characterId] = selectedChoice;

        selections.set(userId, userSelections);

        // Update the public poll silently
        await interaction.deferUpdate();

        return;
    }

    // -------------------------
    // CONFIRM
    // -------------------------

    if (interaction.isButton()) {

        if (interaction.customId !== 'confirm_vote') return;

        const userId = interaction.user.id;

        const userSelections =
            selections.get(userId) || {};

        // Check all five characters
        const complete = characters.every(character =>
            userSelections[character.id]
        );

        if (!complete) {

            await interaction.reply({
                content:
                    '❌ Please choose an option for all five characters before confirming your vote.',
                ephemeral: true
            });

            return;
        }

        // Check each choice is unique
        const usedChoices =
            Object.values(userSelections);

        const uniqueChoices =
            new Set(usedChoices);

        if (uniqueChoices.size !== 5) {

            await interaction.reply({
                content:
                    '❌ Each option must be used exactly once.',
                ephemeral: true
            });

            return;
        }

        // Save vote
        votes.set(userId, {
            ...userSelections
        });

        await interaction.reply({
            content:
                '✅ **Your vote has been submitted!**',
            ephemeral: true
        });

        await updateResults();

        return;
    }
});

// -------------------------
// POLL EMBED
// -------------------------

function createPollEmbed() {

    return new EmbedBuilder()

        .setTitle(
            '😈 FRIEND-ZONE • SNOG • SMASH • MARRY • KILL'
        )

        .setDescription(
            '**Assign one option to each character.**\n' +
            '**Use each option exactly once.**\n' +
            'You can change your choices before confirming your vote.\n\n' +
            'When you are happy with your choices, press **✅ CONFIRM VOTE**.'
        )

        .setImage(imageUrl)

        .addFields({
            name: '📊 LIVE RESULTS',
            value: createResultsText()
        });
}

// -------------------------
// DROPDOWNS + CONFIRM
// -------------------------

function createPollComponents() {

    const rows = [];

    for (const character of characters) {

        const menu =
            new StringSelectMenuBuilder()
                .setCustomId(`character_${character.id}`)
                .setPlaceholder(
                    `${character.name} — Choose an option`
                )
                .addOptions(

                    {
                        label: 'FRIEND-ZONE',
                        value: 'friendzone',
                        emoji: '💙'
                    },

                    {
                        label: 'SNOG',
                        value: 'snog',
                        emoji: '😘'
                    },

                    {
                        label: 'SMASH',
                        value: 'smash',
                        emoji: '🔥'
                    },

                    {
                        label: 'MARRY',
                        value: 'marry',
                        emoji: '💍'
                    },

                    {
                        label: 'KILL',
                        value: 'kill',
                        emoji: '💀'
                    }
                );

        rows.push(
            new ActionRowBuilder()
                .addComponents(menu)
        );
    }

    return rows;
}

// -------------------------
// RESULTS
// -------------------------

function createResultsText() {

    const totals = {
        friendzone: 0,
        snog: 0,
        smash: 0,
        marry: 0,
        kill: 0
    };

    for (const vote of votes.values()) {

        for (const choice of Object.values(vote)) {

            totals[choice]++;
        }
    }

    const max =
        Math.max(...Object.values(totals), 1);

    const totalVotes = votes.size;

    return Object.entries(totals)
        .map(([choice, total]) => {

            const bars =
                Math.round((total / max) * 10);

            const filled =
                '█'.repeat(bars);

            const empty =
                '░'.repeat(10 - bars);

            return (
                `${choiceEmoji[choice]} **${choices[choice].replace(choiceEmoji[choice] + ' ', '')}**\n` +
                `${filled}${empty} **${total}**`
            );

        })
        .join('\n\n') +

        `\n\n👥 **${totalVotes} completed vote${totalVotes === 1 ? '' : 's'}**`;
}

// -------------------------
// UPDATE RESULTS
// -------------------------

async function updateResults() {

    if (!pollMessage) return;

    try {

        await pollMessage.edit({
            embeds: [
                createPollEmbed()
            ],
            components: createPollComponents()
        });

    } catch (error) {

        console.error(
            'Could not update poll:',
            error
        );

    }
}

// -------------------------

client.login(process.env.DISCORD_TOKEN);
