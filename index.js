const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder
} = require('discord.js');

const http = require('http');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds
    ]
});

const commands = [
    new SlashCommandBuilder()
        .setName('poll')
        .setDescription('Create a S.M.A.K. poll')
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
        console.error('Could not register slash command:', error);
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'poll') {
        const embed = new EmbedBuilder()
            .setTitle('😈 SNOG • MARRY • AVOID • KILL')
            .setDescription(
                'Our first test poll is working!\n\n' +
                'The full character images and voting system will be added next.'
            );

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('snog')
                    .setLabel('😘 SNOG')
                    .setStyle(ButtonStyle.Primary),

                new ButtonBuilder()
                    .setCustomId('marry')
                    .setLabel('💍 MARRY')
                    .setStyle(ButtonStyle.Success),

                new ButtonBuilder()
                    .setCustomId('avoid')
                    .setLabel('🚫 AVOID')
                    .setStyle(ButtonStyle.Secondary),

                new ButtonBuilder()
                    .setCustomId('kill')
                    .setLabel('💀 KILL')
                    .setStyle(ButtonStyle.Danger)
            );

        await interaction.reply({
            embeds: [embed],
            components: [row]
        });
    }
});

// Small web server required by Render
const port = process.env.PORT || 3000;

http.createServer((req, res) => {
    res.writeHead(200);
    res.end('MayorBot is running.');
}).listen(port, () => {
    console.log(`Web server listening on port ${port}`);
});

client.login(process.env.DISCORD_TOKEN);
