/**
 * Analytics — anonymous usage tracking + Discord milestone notifications.
 *
 * Logs every generation to Supabase.
 * Fires a Discord webhook at 10 / 50 / 100 / 500 unique users.
 * Exposes a weeklySummary() used by the cron endpoint.
 */

// Supabase REST client (no SDK needed for simple inserts + selects)
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_KEY; // service role key (server-side only)
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;

// Unique-user milestones that trigger a Discord notification
const MILESTONES = [10, 50, 100, 500, 1000];

// ── Supabase helpers ──────────────────────────────────────────────────────────

function supabaseHeaders() {
  return {
    "Content-Type": "application/json",
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    Prefer: "return=minimal",
  };
}

async function supabaseInsert(table, row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: supabaseHeaders(),
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase insert failed (${res.status}): ${text}`);
  }
}

async function supabaseSelect(table, query = "") {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: { ...supabaseHeaders(), Prefer: "return=representation" },
  });
  if (!res.ok) throw new Error(`Supabase select failed: ${res.status}`);
  return res.json();
}

// ── Discord helper ────────────────────────────────────────────────────────────

async function sendDiscord(content) {
  if (!DISCORD_WEBHOOK) return;
  await fetch(DISCORD_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

// ── Core: log an event ────────────────────────────────────────────────────────

/**
 * Log a generation event and check for milestone notifications.
 * Fire-and-forget — never throws so a logging failure can't break /generate.
 *
 * @param {string} userId   - anonymous UUID from the extension
 * @param {string} tone     - "friendly" | "professional" | "direct"
 * @param {boolean} success - whether generation succeeded
 */
async function logEvent(userId, tone, success) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return; // analytics not configured

  try {
    await supabaseInsert("events", { user_id: userId, tone, success });
    await checkMilestones();
  } catch (err) {
    console.error("[analytics] logEvent error:", err.message);
  }
}

// ── Milestones ────────────────────────────────────────────────────────────────

async function checkMilestones() {
  // Count distinct users total
  const rows = await supabaseSelect(
    "events",
    "select=user_id&success=eq.true"
  );
  const uniqueUsers = new Set(rows.map((r) => r.user_id)).size;

  // Which milestones have already been notified?
  const triggered = await supabaseSelect("milestones", "select=name");
  const done = new Set(triggered.map((r) => r.name));

  for (const milestone of MILESTONES) {
    if (uniqueUsers >= milestone && !done.has(String(milestone))) {
      await supabaseInsert("milestones", { name: String(milestone) });
      await sendDiscord(buildMilestoneMessage(milestone, uniqueUsers));
    }
  }
}

function buildMilestoneMessage(milestone, total) {
  const lines = {
    10: `🚀 **OutreachAI hit ${milestone} users!** Total unique users: **${total}**\nGreat early signal. Keep sharing — aim for 50.`,
    50: `🔥 **${milestone} users on OutreachAI!** Total: **${total}**\nYou've got real traction. Start thinking about a freemium limit soon.`,
    100: [
      `🎉 **100 users on OutreachAI!** Total: **${total}**`,
      ``,
      `**It's time to go paid.**`,
      `Here's why:`,
      `• 100 users means people actually find this useful`,
      `• API cost at this scale is still ~$3-5/month — trivial`,
      `• Adding a free tier limit NOW (e.g. 20 generations/month) converts engaged users before they take it for granted`,
      ``,
      `**Suggested move:** Add a 20 free generations/month cap. Charge $6/month for unlimited. Ship it this weekend.`,
    ].join("\n"),
    500: `💰 **500 users on OutreachAI!** Total: **${total}**\nIf you haven't added a paywall yet — do it today. This is product-market fit territory.`,
    1000: `🦄 **1,000 users!** Total: **${total}**\nYou have a real product. Prioritize paid conversion and consider a proper pricing page.`,
  };
  return lines[milestone] || `📈 OutreachAI milestone: **${milestone} users** (${total} total)`;
}

// ── Weekly summary (called by cron endpoint) ──────────────────────────────────

async function weeklySummary() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { error: "Analytics not configured." };
  }

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [allRows, weekRows] = await Promise.all([
    supabaseSelect("events", "select=user_id,tone,success"),
    supabaseSelect(
      "events",
      `select=user_id,tone,success&created_at=gte.${sevenDaysAgo}`
    ),
  ]);

  const totalUsers    = new Set(allRows.map((r) => r.user_id)).size;
  const totalGens     = allRows.filter((r) => r.success).length;
  const weekUsers     = new Set(weekRows.map((r) => r.user_id)).size;
  const weekGens      = weekRows.filter((r) => r.success).length;
  const avgGensPerUser = totalUsers ? (totalGens / totalUsers).toFixed(1) : 0;

  // Tone breakdown
  const toneCounts = {};
  allRows.forEach(({ tone }) => {
    if (tone) toneCounts[tone] = (toneCounts[tone] || 0) + 1;
  });
  const toneStr = Object.entries(toneCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t}: ${n}`)
    .join(", ");

  // Monetization signal
  const signal =
    totalUsers >= 100
      ? "🔴 **Go paid now.** You have 100+ users."
      : totalUsers >= 50
      ? "🟡 **Start adding a limit.** 50+ users reached."
      : avgGensPerUser >= 5
      ? "🟡 **High engagement** — users avg 5+ gens. They're hooked. Good time to add a cap."
      : "🟢 Still in growth mode. Keep sharing.";

  const message = [
    `📊 **OutreachAI Weekly Summary** (${new Date().toDateString()})`,
    ``,
    `**All-time**`,
    `• Unique users: **${totalUsers}**`,
    `• Total generations: **${totalGens}**`,
    `• Avg gens/user: **${avgGensPerUser}**`,
    `• Tone breakdown: ${toneStr || "N/A"}`,
    ``,
    `**This week**`,
    `• New/active users: **${weekUsers}**`,
    `• Generations: **${weekGens}**`,
    ``,
    `**Monetization signal**`,
    signal,
  ].join("\n");

  await sendDiscord(message);
  return { totalUsers, totalGens, weekUsers, weekGens, avgGensPerUser };
}

module.exports = { logEvent, weeklySummary };
