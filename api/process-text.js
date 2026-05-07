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

function send(res, status, payload) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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
    const { text, action = "rewrite", plan = "free" } = req.body || {};

    if (!text || typeof text !== "string") {
      return send(res, 400, { error: "Missing text" });
    }

    const prompt = `${ACTION_PROMPTS[action] || ACTION_PROMPTS.rewrite}\n\n${text}`;

    // Temporary plan logic. Stripe will later decide this from the database.
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
      userId: user?.id || null
    });
  } catch (error) {
    return send(res, 500, {
      error: error.message || "Server error"
    });
  }
}
