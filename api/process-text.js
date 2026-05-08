import { createClient } from "@supabase/supabase-js";

const ACTION_PROMPTS = {
  rewrite:
    "Rewrite the following text to improve clarity, flow, and grammar. Keep the same meaning and approximate length. Return only the improved text.",
  make_formal:
    "Rewrite the following text in a formal, professional tone. Avoid contractions and casual language. Return only the rewritten text.",
  make_shorter:
    "Make the following text significantly shorter while preserving the key information. Return only the shortened text.",
  answer_question:
    "Answer the following question directly and helpfully. If it is multiple choice, identify the best answer and briefly explain why.",
  explain_text:
    "Explain the following text clearly. Give the main idea first, then the important details.",
  explain_simply:
    "Explain the following text in very simple, plain language. Use short sentences and common words."
};

const usageByIdentity = globalThis.__simplitUsageByIdentity || new Map();
globalThis.__simplitUsageByIdentity = usageByIdentity;
const supabaseAdmin =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : null;

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getFreeLimit() {
  return Number.parseInt(process.env.FREE_DAILY_LIMIT || "10", 10);
}

function getProUserIds() {
  return new Set(
    (process.env.PRO_USER_IDS || "")
      .split(/[\s,;]+/)
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function getProEmails() {
  return new Set(
    (process.env.PRO_EMAILS || "")
      .split(/[\s,;]+/)
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );
}

function getUserPlan(user) {
  if (!user) return "free";
  if ((process.env.FORCE_PRO || "").toLowerCase() === "true") return "pro";
  if (getProUserIds().has(user.id)) return "pro";
  const proEmails = getProEmails();
  if (proEmails.has("*")) return "pro";
  if (user.email && proEmails.has(user.email.toLowerCase())) return "pro";
  return "free";
}

function getDeviceId(req) {
  const raw = req.headers["x-simplit-device-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || typeof value !== "string") return "";
  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
}

function getUserUsageKey(user) {
  return `${todayKey()}:user:${user.id}`;
}

function getDeviceUsageKey(deviceId) {
  return `${todayKey()}:device:${deviceId}`;
}

async function readStoredUsage(identityType, identityId) {
  if (!supabaseAdmin) return null;

  const { data, error } = await supabaseAdmin
    .from("simplit_usage_limits")
    .select("used")
    .eq("usage_date", todayKey())
    .eq("identity_type", identityType)
    .eq("identity_id", identityId)
    .maybeSingle();

  if (error) return null;
  return data?.used || 0;
}

async function writeStoredUsage(identityType, identityId, used) {
  if (!supabaseAdmin) return false;

  const { error } = await supabaseAdmin
    .from("simplit_usage_limits")
    .upsert(
      {
        usage_date: todayKey(),
        identity_type: identityType,
        identity_id: identityId,
        used,
        updated_at: new Date().toISOString()
      },
      { onConflict: "usage_date,identity_type,identity_id" }
    );

  return !error;
}

async function checkAndIncrementUsage(user, plan, deviceId) {
  if (plan === "pro") {
    return { requestsRemaining: 999, requestsUsed: 0 };
  }

  const limit = getFreeLimit();
  const userKey = getUserUsageKey(user);
  const deviceKey = getDeviceUsageKey(deviceId);
  let userUsed = usageByIdentity.get(userKey) || 0;
  let deviceUsed = usageByIdentity.get(deviceKey) || 0;

  const storedUserUsed = await readStoredUsage("user", user.id);
  const storedDeviceUsed = await readStoredUsage("device", deviceId);
  if (storedUserUsed !== null) userUsed = Math.max(userUsed, storedUserUsed);
  if (storedDeviceUsed !== null) deviceUsed = Math.max(deviceUsed, storedDeviceUsed);

  const used = Math.max(userUsed, deviceUsed);
  if (used >= limit) {
    return {
      limitReached: true,
      requestsRemaining: 0,
      requestsUsed: used
    };
  }

  const nextUserUsed = userUsed + 1;
  const nextDeviceUsed = deviceUsed + 1;
  const nextUsed = Math.max(nextUserUsed, nextDeviceUsed);
  usageByIdentity.set(userKey, nextUserUsed);
  usageByIdentity.set(deviceKey, nextDeviceUsed);
  await writeStoredUsage("user", user.id, nextUserUsed);
  await writeStoredUsage("device", deviceId, nextDeviceUsed);

  return {
    requestsRemaining: Math.max(0, limit - nextUsed),
    requestsUsed: nextUsed
  };
}

function send(res, status, payload) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Simplit-Device-ID");
  return res.status(status).json(payload);
}

async function getUser(req) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token) return null;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_PUBLISHABLE_KEY) return null;

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_PUBLISHABLE_KEY
  );

  const { data, error } = await supabase.auth.getUser(token);
  if (error) return null;
  return data.user;
}

async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

  const model = process.env.FREE_MODEL || "gemini-2.5-flash-lite";
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 1024,
          temperature: 0.7
        }
      })
    }
  );

  const json = await response.json();
  if (!response.ok) {
    throw new Error(json?.error?.message || "Gemini request failed");
  }

  return json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
}

async function callOpenAI(prompt, plan) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const model =
    plan === "pro"
      ? process.env.OPENAI_PRO_MODEL || "gpt-4.1-mini"
      : process.env.OPENAI_FREE_MODEL || "gpt-4.1-nano";

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1024,
      temperature: 0.7
    })
  });

  const json = await response.json();
  if (!response.ok) {
    throw new Error(json?.error?.message || "OpenAI request failed");
  }

  return json?.choices?.[0]?.message?.content?.trim();
}

async function callClaude(prompt) {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) throw new Error("Missing CLAUDE_API_KEY");

  const model = process.env.PRO_MODEL || "claude-3-5-haiku-latest";
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }]
    })
  });

  const json = await response.json();
  if (!response.ok) {
    throw new Error(json?.error?.message || "Claude request failed");
  }

  return json?.content?.find((part) => part.type === "text")?.text?.trim();
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return send(res, 200, { ok: true });
  if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });

  try {
    const user = await getUser(req);
    if (!user) {
      return send(res, 401, { error: "Please log in to use Simplit." });
    }

    const deviceId = getDeviceId(req);
    if (!deviceId) {
      return send(res, 400, { error: "Please update Simplit before using the AI." });
    }

    const { text, action = "rewrite" } = req.body || {};

    if (!text || typeof text !== "string") {
      return send(res, 400, { error: "Missing text" });
    }

    const prompt = `${ACTION_PROMPTS[action] || ACTION_PROMPTS.rewrite}\n\n${text}`;

    const plan = getUserPlan(user);
    const usage = await checkAndIncrementUsage(user, plan, deviceId);
    if (usage.limitReached) {
      return send(res, 429, {
        error: "You have no free requests left.",
        plan,
        requestsRemaining: usage.requestsRemaining,
        requestsUsed: usage.requestsUsed
      });
    }

    const isPro = plan === "pro";
    let modelProvider = "openai";
    let result;

    if (isPro && process.env.CLAUDE_API_KEY) {
      modelProvider = "claude";
      result = await callClaude(prompt);
    } else if (process.env.OPENAI_API_KEY) {
      result = await callOpenAI(prompt, isPro ? "pro" : "free");
    } else {
      modelProvider = "gemini";
      result = await callGemini(prompt);
    }

    if (!result) {
      return send(res, 502, { error: "No model response" });
    }

    return send(res, 200, {
      result,
      modelProvider,
      plan,
      requestsRemaining: usage.requestsRemaining,
      requestsUsed: usage.requestsUsed,
      userId: user.id
    });
  } catch (error) {
    return send(res, 500, {
      error: error.message || "Server error"
    });
  }
}
