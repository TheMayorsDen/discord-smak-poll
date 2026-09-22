const http = require('http');

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

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds
    ]
});

const port = process.env.PORT || 3000;

http.createServer((req, res) => {
    res.writeHead(200);
    res.end('MayorBot is running.');
}).listen(port, () => {
    console.log(`Web server listening on port ${port}`);
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

    // /poll command
    if (interaction.isChatInputCommand()) {

        if (interaction.commandName === 'poll') {

            const embed = new EmbedBuilder()
                .setTitle('😈 SNOG • MARRY • AVOID • KILL')
                .setDescription(
                    'Choose one of the four options below.'
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

        return;
    }

    // Button clicks
    if (interaction.isButton()) {

        const choices = {
            snog: '😘 SNOG',
            marry: '💍 MARRY',
            avoid: '🚫 AVOID',
            kill: '💀 KILL'
        };

        const choice = choices[interaction.customId];

        if (!choice) return;

        await interaction.reply({
            content: `You selected **${choice}**.`,
            ephemeral: true
        });
    }
});

client.login(process.env.DISCORD_TOKEN);
