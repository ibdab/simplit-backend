import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY;
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

function sendJson(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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
    const { prompt, imageBase64, mimeType = "image/jpeg", plan = "free" } = req.body || {};
    if (!imageBase64) {
      return sendJson(res, 400, { error: "Missing imageBase64" });
    }

    const user = await getUser(req);
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
      userId: user?.id || null
    });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || "Image processing failed" });
  }
}
