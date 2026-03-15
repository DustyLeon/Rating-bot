const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
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
function buildMenu(messageId) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`rate_${messageId}`)
    .setPlaceholder('Rate this track (1–10)')
    .addOptions(
      Array.from({ length: 10 }, (_, i) => {
        const score = i + 1;
        return new StringSelectMenuOptionBuilder()
          .setLabel(`${score}`)
          .setValue(`${score}`);
      })
    );
  return [new ActionRowBuilder().addComponents(menu)];
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

// New message in the feed channel → attach rating prompt
client.on('messageCreate', async (message) => {
  if (message.channelId !== CHANNEL_ID) return;
  if (message.author.id === client.user.id) return; // ignore own messages

  try {
    const content    = await buildContent(message.id);
    const components = buildMenu(message.id);
    await message.reply({ content, components });
  } catch (err) {
    console.error('Failed to post rating prompt:', err);
  }
});

// Select menu interaction → upsert vote, update the rating message in place
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (!interaction.customId.startsWith('rate_')) return;

  // Custom ID format: rate_{messageId}
  const messageId = interaction.customId.slice(5);
  const score     = parseInt(interaction.values[0], 10);

  if (isNaN(score) || score < 1 || score > 10) return;

  try {
    await pool.query(
      `INSERT INTO votes (message_id, user_id, score)
       VALUES ($1, $2, $3)
       ON CONFLICT (message_id, user_id)
       DO UPDATE SET score = EXCLUDED.score`,
      [messageId, interaction.user.id, score]
    );

    const content    = await buildContent(messageId);
    const components = buildMenu(messageId);
    await interaction.update({ content, components });
  } catch (err) {
    console.error('Failed to record vote:', err);
    await interaction.deferUpdate().catch(() => {});
  }
});

client.login(DISCORD_TOKEN);
