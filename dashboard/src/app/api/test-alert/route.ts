import { NextRequest, NextResponse } from "next/server";

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT_IDS = (process.env.TELEGRAM_CHAT_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { name, url } = body;

  const results: string[] = [];

  // Telegram
  if (TG_TOKEN && TG_CHAT_IDS.length > 0) {
    const text = `🔔 <b>Test Alert: ${name}</b>\n${url}\n\nThis is a test notification from Site Monitor. If you see this, alerts are working!`;
    for (const chatId of TG_CHAT_IDS) {
      try {
        const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
        });
        if (r.ok) results.push(`Telegram (${chatId}): sent`);
        else results.push(`Telegram (${chatId}): failed`);
      } catch (err) {
        results.push(`Telegram (${chatId}): error - ${err}`);
      }
    }
  } else {
    results.push("Telegram: not configured");
  }

  // Email (if configured)
  const smtpHost = process.env.SMTP_HOST;
  const smtpUser = process.env.SMTP_USER;
  if (smtpHost && smtpUser) {
    results.push("Email: configured (test alerts only sent via Telegram)");
  } else {
    results.push("Email: not configured locally (works on GitHub Actions)");
  }

  return NextResponse.json({ results });
}
