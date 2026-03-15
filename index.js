const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
} = require('discord.js');
const { Pool } = require('pg');

// ── Config ────────────────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID    = process.env.CHANNEL_ID;
const DATABASE_URL  = process.env.DATABASE_URL;
const CLIENT_ID     = process.env.CLIENT_ID;
const GUILD_ID      = process.env.GUILD_ID;

if (!DISCORD_TOKEN || !CHANNEL_ID || !DATABASE_URL || !CLIENT_ID || !GUILD_ID) {
  console.error('Missing required environment variables: DISCORD_TOKEN, CHANNEL_ID, DATABASE_URL, CLIENT_ID, GUILD_ID');
  process.exit(1);
}

// ── Ranks ─────────────────────────────────────────────────────────────────────
const RANKS = [
  { level: 1,  name: 'Scout',             xp: 10  },
  { level: 2,  name: 'Engaged Listener',  xp: 40  },
  { level: 3,  name: 'Music Buff',        xp: 70  },
  { level: 4,  name: 'Critic',            xp: 100 },
  { level: 5,  name: 'Archivist',         xp: 130 },
  { level: 6,  name: 'Tastemaker',        xp: 160 },
  { level: 7,  name: 'Esteemed Critic',   xp: 190 },
  { level: 8,  name: 'Shrewd Advisor',    xp: 220 },
  { level: 9,  name: 'Resident Expert',   xp: 250 },
  { level: 10, name: 'Master Curator',    xp: 300 },
];

function getLevelForXp(xp) {
  let level = 0;
  for (const rank of RANKS) {
    if (xp >= rank.xp) level = rank.level;
  }
  return level;
}

function getRankName(level) {
  const rank = RANKS.find(r => r.level === level);
  return rank ? rank.name : null;
}

function getNextRank(level) {
  return RANKS.find(r => r.level === level + 1) || null;
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT    PRIMARY KEY,
      xp      INTEGER NOT NULL DEFAULT 0,
      level   INTEGER NOT NULL DEFAULT 0
    )
  `);
  console.log('Database ready.');
}

// ── Slash command registration ────────────────────────────────────────────────
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('rank')
      .setDescription('Check your current XP and rank')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('leaderboard')
      .setDescription('Show the top 10 raters in this server')
      .toJSON(),
  ];

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log('Slash commands registered.');
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

// Award XP if this is the user's first vote on this message.
// Returns { leveled_up, old_level, new_level } or null if no XP awarded.
async function maybeAwardXp(userId, messageId) {
  const existing = await pool.query(
    'SELECT 1 FROM votes WHERE message_id = $1 AND user_id = $2',
    [messageId, userId]
  );
  if (existing.rows.length > 0) return null; // vote change, no XP

  // Upsert user row and add XP
  const { rows } = await pool.query(
    `INSERT INTO users (user_id, xp, level)
     VALUES ($1, 10, 0)
     ON CONFLICT (user_id)
     DO UPDATE SET xp = users.xp + 10
     RETURNING xp`,
    [userId]
  );
  const newXp      = rows[0].xp;
  const newLevel   = getLevelForXp(newXp);

  // Check old level
  const oldRow = await pool.query('SELECT level FROM users WHERE user_id = $1', [userId]);
  const oldLevel = oldRow.rows[0]?.level ?? 0;

  if (newLevel > oldLevel) {
    await pool.query('UPDATE users SET level = $1 WHERE user_id = $2', [newLevel, userId]);
    return { leveled_up: true, old_level: oldLevel, new_level: newLevel };
  }

  return { leveled_up: false };
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
  await registerCommands();
});

// New message → attach rate button
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

  // ── Button → open modal ───────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('open_modal_')) {
    const messageId = interaction.customId.slice('open_modal_'.length);
    await interaction.showModal(buildModal(messageId));
    return;
  }

  // ── Modal submit → record vote + XP ──────────────────────────────────────
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
      // Award XP before the upsert so we can detect first-vote
      const xpResult = await maybeAwardXp(interaction.user.id, messageId);

      await pool.query(
        `INSERT INTO votes (message_id, user_id, score)
         VALUES ($1, $2, $3)
         ON CONFLICT (message_id, user_id)
         DO UPDATE SET score = EXCLUDED.score`,
        [messageId, interaction.user.id, score]
      );

      // Update the rating message
      const channel      = await client.channels.fetch(CHANNEL_ID);
      const replyMessage = await channel.messages.fetch(interaction.message.id);
      const content      = await buildContent(messageId);
      await replyMessage.edit({ content, components: buildButton(messageId) });

      // Confirm to the voter
      let confirmation = `Your rating of **${score}/10** has been recorded.`;
      if (xpResult) {
        const userRow  = await pool.query('SELECT xp, level FROM users WHERE user_id = $1', [interaction.user.id]);
        const { xp, level } = userRow.rows[0];
        const rankName = getRankName(level) || 'Unranked';
        const next     = getNextRank(level);
        confirmation += xpResult.leveled_up
          ? `\n+10 XP · You leveled up to **${rankName}**! 🎉`
          : `\n+10 XP · **${rankName}** · ${xp} XP${next ? ` (${next.xp - xp} to ${next.name})` : ''}`;
      } else {
        confirmation += '\nVote updated — no XP for changes.';
      }

      await interaction.reply({ content: confirmation, ephemeral: true });

      // Public level-up announcement
      if (xpResult?.leveled_up) {
        const rankName = getRankName(xpResult.new_level);
        await channel.send(`🏆 <@${interaction.user.id}> just reached the rank of **${rankName}**!`);
      }

    } catch (err) {
      console.error('Failed to record vote:', err);
      await interaction.reply({
        content: 'Something went wrong saving your vote. Please try again.',
        ephemeral: true,
      });
    }
    return;
  }

  // ── /rank ─────────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'rank') {
    const { rows } = await pool.query(
      'SELECT xp, level FROM users WHERE user_id = $1',
      [interaction.user.id]
    );
    if (rows.length === 0 || rows[0].xp === 0) {
      await interaction.reply({ content: 'You haven\'t rated any tracks yet!', ephemeral: true });
      return;
    }
    const { xp, level } = rows[0];
    const rankName = getRankName(level) || 'Unranked';
    const next     = getNextRank(level);
    const embed    = new EmbedBuilder()
      .setTitle(`${interaction.user.displayName}'s Rank`)
      .addFields(
        { name: 'Rank',  value: rankName,     inline: true },
        { name: 'Level', value: `${level}`,   inline: true },
        { name: 'XP',    value: `${xp}`,      inline: true },
      )
      .setColor(0x5865F2);
    if (next) embed.setFooter({ text: `${next.xp - xp} XP to ${next.name}` });
    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  // ── /leaderboard ──────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'leaderboard') {
    const { rows } = await pool.query(
      'SELECT user_id, xp, level FROM users ORDER BY xp DESC LIMIT 10'
    );
    if (rows.length === 0) {
      await interaction.reply({ content: 'No ratings yet!', ephemeral: true });
      return;
    }
    const lines = rows.map((row, i) => {
      const rankName = getRankName(row.level) || 'Unranked';
      return `**${i + 1}.** <@${row.user_id}> — ${rankName} · ${row.xp} XP`;
    });
    const embed = new EmbedBuilder()
      .setTitle('🏆 Top Raters')
      .setDescription(lines.join('\n'))
      .setColor(0x5865F2);
    await interaction.reply({ embeds: [embed] });
    return;
  }

});

client.login(DISCORD_TOKEN);
