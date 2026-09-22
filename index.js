const http = require('http');

const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    EmbedBuilder
} = require('discord.js');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds
    ]
});

// Render requires a web server
const port = process.env.PORT || 3000;

http.createServer((req, res) => {
    res.writeHead(200);
    res.end('MayorBot is running.');
}).listen(port, () => {
    console.log(`Web server listening on port ${port}`);
});

// --------------------------------------------------
// POLL SETTINGS
// --------------------------------------------------

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

// Stores everyone's submitted votes
const votes = new Map();

// Stores people's selections before they submit
const selections = new Map();

// --------------------------------------------------
// SLASH COMMAND
// --------------------------------------------------

const commands = [
    new SlashCommandBuilder()
        .setName('poll')
        .setDescription('Create the S.M.A.K. poll')
].map(command => command.toJSON());

// --------------------------------------------------
// BOT READY
// --------------------------------------------------

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

        console.error('Could not register slash command:', error);

    }
});

// --------------------------------------------------
// CREATE POLL
// --------------------------------------------------

client.on('interactionCreate', async interaction => {

    if (interaction.isChatInputCommand()) {

        if (interaction.commandName === 'poll') {

            const imageUrl =
                'https://raw.githubusercontent.com/TheMayorsDen/discord-smak-poll/main/smak_five_character_panel.png';

            const embed = new EmbedBuilder()
                .setTitle('😈 SNOG • SMASH • MARRY • KILL')
                .setDescription(
                    '**Assign one different option to each character.**\n\n' +
                    'You must use **all five options exactly once**.\n\n' +
                    'Your vote is automatically submitted when all five choices are complete.'
                )
                .setImage(imageUrl);

            const rows = characters.map(character => {

                return new ActionRowBuilder()
                    .addComponents(

                        new StringSelectMenuBuilder()
                            .setCustomId(`character_${character.id}`)
                            .setPlaceholder(`${character.name} — Choose an option`)
                            .addOptions(

                                {
                                    label: 'FRIEND-ZONE',
                                    description: `Friend-zone ${character.name}`,
                                    value: 'friendzone',
                                    emoji: '💙'
                                },

                                {
                                    label: 'SNOG',
                                    description: `Snog ${character.name}`,
                                    value: 'snog',
                                    emoji: '😘'
                                },

                                {
                                    label: 'SMASH',
                                    description: `Smash ${character.name}`,
                                    value: 'smash',
                                    emoji: '🔥'
                                },

                                {
                                    label: 'MARRY',
                                    description: `Marry ${character.name}`,
                                    value: 'marry',
                                    emoji: '💍'
                                },

                                {
                                    label: 'KILL',
                                    description: `Kill ${character.name}`,
                                    value: 'kill',
                                    emoji: '💀'
                                }

                            )
                    );

            });

            await interaction.reply({
                embeds: [embed],
                components: rows
            });

        }

        return;
    }

    // --------------------------------------------------
    // CHARACTER SELECTION
    // --------------------------------------------------

    if (interaction.isStringSelectMenu()) {

        const userId = interaction.user.id;

        const characterId =
            interaction.customId.replace('character_', '');

        const selectedChoice =
            interaction.values[0];

        // Get existing selections
        let userSelections =
            selections.get(userId) || {};

        // Check whether this choice is already being used
        const alreadyUsedBy =
            Object.entries(userSelections)
                .find(([character, choice]) =>
                    choice === selectedChoice &&
                    character !== characterId
                );

        if (alreadyUsedBy) {

            const otherCharacter =
                characters.find(c =>
                    c.id === alreadyUsedBy[0]
                );

            await interaction.reply({

                content:
                    `❌ You have already used **${choices[selectedChoice]}** ` +
                    `for **${otherCharacter.name}**.\n\n` +
                    `Each option can only be used once. ` +
                    `Change your existing ${choices[selectedChoice]} choice first.`,

                ephemeral: true

            });

            return;
        }

        // Save the selection
        userSelections[characterId] =
            selectedChoice;

        selections.set(userId, userSelections);

        // Check whether all five characters have choices
        const complete =
            characters.every(character =>
                userSelections[character.id]
            );

        if (!complete) {

            const remaining =
                characters.filter(character =>
                    !userSelections[character.id]
                );

            await interaction.reply({

                content:
                    `✅ **${characters.find(c => c.id === characterId).name}** ` +
                    `set to **${choices[selectedChoice]}**.\n\n` +
                    `You still need to choose for: **${remaining.map(c => c.name).join(', ')}**.`,

                ephemeral: true

            });

            return;
        }

        // --------------------------------------------------
        // SUBMIT COMPLETE VOTE
        // --------------------------------------------------

        votes.set(userId, { ...userSelections });

        await interaction.reply({

            content:
                '🎉 **Your complete vote has been submitted!**\n\n' +
                characters.map(character =>
                    `**${character.name}:** ${choices[userSelections[character.id]]}`
                ).join('\n'),

            ephemeral: true

        });

        // Update results message if possible
        await updateResults(interaction);

    }

});

// --------------------------------------------------
// UPDATE RESULTS
// --------------------------------------------------

async function updateResults(interaction) {

    const totals = {
        friendzone: 0,
        snog: 0,
        smash: 0,
        marry: 0,
        kill: 0
    };

    for (const vote of votes.values()) {

        for (const choice of Object.values(vote)) {

            if (totals[choice] !== undefined) {
                totals[choice]++;
            }

        }

    }

    const totalVotes = votes.size;

    console.log(`Current completed votes: ${totalVotes}`);

    console.log(
        `Friend-zone: ${totals.friendzone} | ` +
        `Snog: ${totals.snog} | ` +
        `Smash: ${totals.smash} | ` +
        `Marry: ${totals.marry} | ` +
        `Kill: ${totals.kill}`
    );
}

// --------------------------------------------------

client.login(process.env.DISCORD_TOKEN);
