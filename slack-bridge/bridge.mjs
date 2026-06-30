// Atelier Slack bridge — DM your team from Slack/your phone.
// Socket Mode: connects OUT to Slack, so no public URL needed (works behind NAT).
// It just routes a Slack message to Atelier's /api/chat/<agent> and posts back.
//   Default agent = Cleo (chief of staff). Address others with "wren: ..." etc.
import pkg from '@slack/bolt';
const { App } = pkg;

const ATELIER = process.env.ATELIER_URL ?? 'http://127.0.0.1:3040';
const AGENTS = ['cleo', 'wren', 'hugo', 'iris', 'vera', 'lena', 'remy', 'marlowe', 'dewey', 'otto'];

function resolve(text) {
  const m = (text || '').trim().toLowerCase().match(/^@?([a-z]+)\s*[,:]\s*/);
  if (m && AGENTS.includes(m[1])) return { slug: m[1], msg: text.slice(m[0].length).trim() };
  return { slug: 'cleo', msg: text || '' };
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

async function handle(text, say) {
  const { slug, msg } = resolve(text);
  if (!msg) { await say('What do you need? (e.g. "wren: 6 headlines for course 19")'); return; }
  try {
    const r = await fetch(`${ATELIER}/api/chat/${slug}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: msg, thread: 'slack' }),
    });
    const j = await r.json();
    await say(j.ok ? `*${slug}* — ${j.reply}` : `(${slug} couldn't reply: ${j.error ?? 'error'})`);
  } catch (e) {
    await say(`(bridge couldn't reach Atelier: ${e.message})`);
  }
}

app.message(async ({ message, say }) => {
  if (message.subtype || message.bot_id) return;     // ignore bot/system messages
  await handle(message.text, say);
});
app.event('app_mention', async ({ event, say }) => {
  await handle((event.text || '').replace(/<@[^>]+>\s*/, ''), say); // strip the @mention
});

await app.start();
console.log(`Atelier Slack bridge running (socket mode) → ${ATELIER}`);
