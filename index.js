const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { Pool } = require('pg');

// ── Config ────────────────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID    = process.env.CHANNEL_ID;
const DATABASE_URL  = process.env.DATABASE_URL;

if (!DISCORD_TOKEN || !CHANNEL_ID || !DATABASE_URL) {
  console.error('Missing required environment variables: DISCORD_TOKEN, CHANNEL_ID, DATABASE_URL');
  process.exit(1);
}

// ── Database ──────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS votes (
      message_id TEXT    NOT NULL,
      user_id    TEXT    NOT NULL,
      score      INTEGER NOT NULL CHECK (score BETWEEN 1 AND 10),
      PRIMARY KEY (message_id, user_id)
    )
  `);
  console.log('Database ready.');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildButton(messageId) {
  const button = new ButtonBuilder()
    .setCustomId(`open_modal_${messageId}`)
    .setLabel('Rate this track')
    .setStyle(ButtonStyle.Primary);
  return [new ActionRowBuilder().addComponents(button)];
}

function buildModal(messageId) {
  const modal = new ModalBuilder()
    .setCustomId(`submit_rating_${messageId}`)
    .setTitle('Rate this track');

  const input = new TextInputBuilder()
    .setCustomId('score_input')
    .setLabel('Your rating (1–10)')
    .setStyle(TextInputStyle.Short)
    .setMinLength(1)
    .setMaxLength(2)
    .setPlaceholder('Enter a number from 1 to 10')
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

async function buildContent(messageId) {
  const { rows } = await pool.query(
    'SELECT score FROM votes WHERE message_id = $1',
    [messageId]
  );
  if (rows.length === 0) {
    return 'No votes yet — be the first!';
  }
  const scores = rows.map(r => r.score);
  const avg    = scores.reduce((a, b) => a + b, 0) / scores.length;
  return `⭐ Average: **${avg.toFixed(2)} / 10** · **${scores.length}** vote${scores.length === 1 ? '' : 's'}`;
}

// ── Discord client ────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await initDb();
});

// New message in the feed channel → attach rate button
client.on('messageCreate', async (message) => {
  if (message.channelId !== CHANNEL_ID) return;
  if (message.author.id === client.user.id) return;

  try {
    const content    = await buildContent(message.id);
    const components = buildButton(message.id);
    await message.reply({ content, components });
  } catch (err) {
    console.error('Failed to post rate button:', err);
  }
});

client.on('interactionCreate', async (interaction) => {

  // ── Button click → open modal ──────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('open_modal_')) {
    const messageId = interaction.customId.slice('open_modal_'.length);
    await interaction.showModal(buildModal(messageId));
    return;
  }

  // ── Modal submit → record vote, update rating message ─────────────────────
  if (interaction.isModalSubmit() && interaction.customId.startsWith('submit_rating_')) {
    const messageId = interaction.customId.slice('submit_rating_'.length);
    const raw       = interaction.fields.getTextInputValue('score_input').trim();
    const score     = parseInt(raw, 10);

    if (isNaN(score) || score < 1 || score > 10) {
      await interaction.reply({
        content: 'Please enter a whole number between 1 and 10.',
        ephemeral: true,
      });
      return;
    }

    try {
      await pool.query(
        `INSERT INTO votes (message_id, user_id, score)
         VALUES ($1, $2, $3)
         ON CONFLICT (message_id, user_id)
         DO UPDATE SET score = EXCLUDED.score`,
        [messageId, interaction.user.id, score]
      );

      // Fetch the original bot reply to update it
      const channel     = await client.channels.fetch(CHANNEL_ID);
      const replyMessage = await channel.messages.fetch(interaction.message.id);
      const content     = await buildContent(messageId);
      const components  = buildButton(messageId);
      await replyMessage.edit({ content, components });

      await interaction.reply({
        content: `Your rating of **${score}/10** has been recorded. You can update it any time by clicking the button again.`,
        ephemeral: true,
      });
    } catch (err) {
      console.error('Failed to record vote:', err);
      await interaction.reply({
        content: 'Something went wrong saving your vote. Please try again.',
        ephemeral: true,
      });
    }
    return;
  }

});

client.login(DISCORD_TOKEN);
