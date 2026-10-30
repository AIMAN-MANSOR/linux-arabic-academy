import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-telegram-bot-api-secret-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET")!;
const CHANNEL = Deno.env.get("TELEGRAM_CHANNEL") || "@something_37";
const BOT_USERNAME = "LinuxArabicAcademyBot";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function hex(buffer: ArrayBuffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function authenticatedUser(req: Request) {
  const header = req.headers.get("Authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new Error("Authentication required");
  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data.user) throw new Error("Invalid or expired session");
  return data.user;
}

async function telegramApi(method: string, payload: Record<string, unknown>) {
  if (!BOT_TOKEN) throw new Error("Telegram bot token is not configured");
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.description || `Telegram API error (${response.status})`);
  return result.result;
}

async function findTelegramAccount(userId: string) {
  const { data, error } = await admin.from("telegram_accounts")
    .select("telegram_user_id,linked_at").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return data;
}

async function membershipForTelegramUser(telegramUserId: number) {
  const member = await telegramApi("getChatMember", {
    chat_id: CHANNEL,
    user_id: telegramUserId,
  });
  const status = String(member.status || "");
  return status === "creator" || status === "administrator" || status === "member" ||
    (status === "restricted" && member.is_member === true);
}

async function createLink(userId: string) {
  const random = crypto.getRandomValues(new Uint8Array(24));
  const token = [...random].map((b) => b.toString(16).padStart(2, "0")).join("");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const tokenHash = await sha256(token);

  // Invalidate old unused links for this account before issuing a new one.
  await admin.from("telegram_link_tokens").delete().eq("user_id", userId).is("used_at", null);
  const { error } = await admin.from("telegram_link_tokens").insert({
    user_id: userId,
    token_hash: tokenHash,
    expires_at: expiresAt,
  });
  if (error) throw error;

  return {
    url: `https://t.me/${BOT_USERNAME}?start=${token}`,
    expires_at: expiresAt,
  };
}

async function handleTelegramWebhook(req: Request, update: any) {
  if (!WEBHOOK_SECRET || req.headers.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) {
    return json({ error: "Forbidden" }, 403);
  }
  const message = update?.message;
  const text = typeof message?.text === "string" ? message.text.trim() : "";
  const match = text.match(/^\/start(?:\s+([A-Za-z0-9_-]{20,64}))?$/);
  if (!match || !match[1] || !message?.from?.id || !message?.chat?.id) {
    return json({ ok: true });
  }

  const tokenHash = await sha256(match[1]);
  const now = new Date().toISOString();
  const { data: link, error: lookupError } = await admin.from("telegram_link_tokens")
    .select("user_id,expires_at,used_at")
    .eq("token_hash", tokenHash)
    .is("used_at", null)
    .gt("expires_at", now)
    .maybeSingle();

  if (lookupError || !link) {
    await telegramApi("sendMessage", {
      chat_id: message.chat.id,
      text: "رابط الربط غير صالح أو انتهت صلاحيته. ارجع إلى موسوعة لينكس العربية وأنشئ رابطاً جديداً.",
    }).catch(() => undefined);
    return json({ ok: true });
  }

  const { error: upsertError } = await admin.from("telegram_accounts").upsert({
    user_id: link.user_id,
    telegram_user_id: message.from.id,
    linked_at: now,
  }, { onConflict: "user_id" });

  if (upsertError) {
    await telegramApi("sendMessage", {
      chat_id: message.chat.id,
      text: "تعذر ربط هذا الحساب. قد يكون حساب Telegram مرتبطاً بحساب آخر. تواصل مع إدارة المنصة.",
    }).catch(() => undefined);
    return json({ ok: true });
  }

  const { error: usedError } = await admin.from("telegram_link_tokens")
    .update({ used_at: now })
    .eq("token_hash", tokenHash)
    .is("used_at", null);
  if (usedError) console.error("Could not mark link token used", usedError.message);

  await telegramApi("sendMessage", {
    chat_id: message.chat.id,
    text: "تم ربط حساب Telegram بموسوعة لينكس العربية بنجاح. ارجع إلى الموقع واشترك في القناة ثم اضغط «تحقق من اشتراكي».",
  }).catch(() => undefined);

  return json({ ok: true });
}

const correctAnswers: Record<string, number[]> = {
  beginner: [1, 0, 1, 2, 0],
  intermediate: [0, 1, 0, 1, 2],
  advanced: [1, 0, 1, 1, 0],
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const payload = await req.json();

    // Telegram webhook updates have a message object and no app action.
    if (payload?.message && !payload?.action) {
      return await handleTelegramWebhook(req, payload);
    }

    const user = await authenticatedUser(req);
    const action = payload?.action;

    if (action === "create-link") {
      return json(await createLink(user.id));
    }

    if (action === "verify-membership") {
      const account = await findTelegramAccount(user.id);
      if (!account) return json({ linked: false, member: false });
      const member = await membershipForTelegramUser(Number(account.telegram_user_id));
      return json({ linked: true, member, channel: CHANNEL });
    }

    if (action === "submit-quiz") {
      const quizId = String(payload?.quiz_id || "");
      const key = correctAnswers[quizId];
      const answers = payload?.answers;
      if (!key || !Array.isArray(answers) || answers.length !== key.length ||
          answers.some((n: unknown) => !Number.isInteger(n) || Number(n) < 0 || Number(n) > 3)) {
        return json({ error: "Invalid quiz submission" }, 400);
      }

      if (quizId !== "beginner") {
        const prerequisite = quizId === "intermediate" ? "beginner" : "intermediate";
        const { data: previous, error: previousError } = await admin.from("quiz_results")
          .select("score").eq("user_id", user.id).eq("quiz_id", prerequisite).gte("score", 80).limit(1);
        if (previousError) throw previousError;
        if (!previous?.length) return json({ error: "Complete the previous level first" }, 403);
      }
      if (quizId === "intermediate" || quizId === "advanced") {
        const account = await findTelegramAccount(user.id);
        if (!account || !(await membershipForTelegramUser(Number(account.telegram_user_id)))) {
          return json({ error: "Active Telegram channel membership is required" }, 403);
        }
      }

      const correct = key.reduce((sum, answer, index) => sum + (answer === answers[index] ? 1 : 0), 0);
      const score = Math.round((correct / key.length) * 100);
      const { error: insertError } = await admin.from("quiz_results").insert({
        user_id: user.id,
        quiz_id: quizId,
        score,
        total_questions: key.length,
      });
      if (insertError) throw insertError;
      return json({ score, correct, total: key.length, passed: score >= 80 });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "Unexpected server error";
    const status = /Authentication required|Invalid or expired session/.test(message) ? 401 : 500;
    return json({ error: message }, status);
  }
});
