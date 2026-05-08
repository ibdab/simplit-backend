import { createClient } from "@supabase/supabase-js";

function send(res, status, payload) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return res.status(status).json(payload);
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

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return send(res, 200, { ok: true });
  if (req.method !== "GET") return send(res, 405, { error: "Method not allowed" });

  const user = await getUser(req);
  if (!user) {
    return send(res, 401, { error: "Please log in to use Simplit." });
  }

  return send(res, 200, {
    ok: true,
    plan: getUserPlan(user),
    userId: user.id,
    proEmailsConfigured: Boolean(process.env.PRO_EMAILS),
    proUserIdsConfigured: Boolean(process.env.PRO_USER_IDS),
    forcePro: (process.env.FORCE_PRO || "").toLowerCase() === "true"
  });
}
