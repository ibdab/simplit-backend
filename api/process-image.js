import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY;
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;
const usageByIdentity = globalThis.__simplitUsageByIdentity || new Map();
globalThis.__simplitUsageByIdentity = usageByIdentity;
const supabaseAdmin =
  supabaseUrl && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY)
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

function sendJson(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Simplit-Device-ID");
}

async function getUser(req) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token || !supabase) {
    return null;
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error) {
    return null;
  }
  return data.user;
}

async function callGeminiVision(prompt, imageBase64) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.FREE_MODEL || "gemini-2.5-flash-lite";

  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY");
  }

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: prompt },
            {
              inline_data: {
                mime_type: "image/png",
                data: imageBase64
              }
            }
          ]
        }
      ],
      generationConfig: {
        maxOutputTokens: 1200,
        temperature: 0.35
      }
    })
  });

  const json = await response.json();

  if (!response.ok) {
    throw new Error(json?.error?.message || "Gemini image request failed");
  }

  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("No image analysis returned");
  }

  return text;
}

async function callOpenAIVision(prompt, imageBase64, mimeType, plan) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY");
  }

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
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${imageBase64}`
              }
            }
          ]
        }
      ],
      max_tokens: 1200,
      temperature: 0.35
    })
  });

  const json = await response.json();
  if (!response.ok) {
    throw new Error(json?.error?.message || "OpenAI image request failed");
  }

  const text = json?.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error("No image analysis returned");
  }

  return text.trim();
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  try {
    const { prompt, imageBase64, mimeType = "image/jpeg" } = req.body || {};
    if (!imageBase64) {
      return sendJson(res, 400, { error: "Missing imageBase64" });
    }

    const user = await getUser(req);
    if (!user) {
      return sendJson(res, 401, { error: "Please log in to use Simplit." });
    }

    const deviceId = getDeviceId(req);
    if (!deviceId) {
      return sendJson(res, 400, { error: "Please update Simplit before using the AI." });
    }

    const plan = getUserPlan(user);
    const usage = await checkAndIncrementUsage(user, plan, deviceId);
    if (usage.limitReached) {
      return sendJson(res, 429, {
        error: "You have no free requests left.",
        plan,
        requestsRemaining: usage.requestsRemaining,
        requestsUsed: usage.requestsUsed
      });
    }

    const finalPrompt = prompt || "Analyze this screenshot and explain what is visible.";
    let modelProvider = "openai";
    let result;

    if (process.env.OPENAI_API_KEY) {
      result = await callOpenAIVision(finalPrompt, imageBase64, mimeType, plan);
    } else {
      modelProvider = "gemini";
      result = await callGeminiVision(finalPrompt, imageBase64);
    }

    return sendJson(res, 200, {
      result,
      modelProvider,
      plan,
      requestsRemaining: usage.requestsRemaining,
      requestsUsed: usage.requestsUsed,
      userId: user.id
    });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || "Image processing failed" });
  }
}
