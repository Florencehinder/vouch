import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL!;

export const supabaseAnon = createClient(url, process.env.SUPABASE_ANON_KEY!);

export const supabaseService = createClient(
  url,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
