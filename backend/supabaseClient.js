import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

let cachedClient = null;

function createClientOrThrow() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in the environment.",
    );
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Lazy Supabase client so the HTTP server can bind (e.g. for /api/health) even if
 * env validation would otherwise fail at import time. DB routes throw on first use
 * if credentials are missing.
 */
export const supabase = new Proxy(Object.create(null), {
  get(_target, prop) {
    if (!cachedClient) {
      cachedClient = createClientOrThrow();
    }
    const value = cachedClient[prop];
    return typeof value === "function" ? value.bind(cachedClient) : value;
  },
});
