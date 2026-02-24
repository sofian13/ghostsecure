import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

export type SupabaseStatus = {
  configured: boolean;
  connected: boolean;
  message: string;
};

function readConfig(): { url: string; anonKey: string; missing: string[] } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  const missing: string[] = [];
  if (!url) missing.push('NEXT_PUBLIC_SUPABASE_URL');
  if (!anonKey) missing.push('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  return { url, anonKey, missing };
}

export function getSupabaseClient(): SupabaseClient {
  if (client) return client;
  const cfg = readConfig();
  if (cfg.missing.length > 0) {
    throw new Error(`Missing env: ${cfg.missing.join(', ')}`);
  }

  client = createClient(
    cfg.url,
    cfg.anonKey,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  return client;
}

export async function checkSupabaseConnection(): Promise<SupabaseStatus> {
  const cfg = readConfig();
  if (cfg.missing.length > 0) {
    return {
      configured: false,
      connected: false,
      message: `Env manquante: ${cfg.missing.join(', ')}`
    };
  }

  try {
    const supabase = getSupabaseClient();
    const { error } = await supabase.from('app_user').select('id', { head: true, count: 'exact' }).limit(1);
    if (error) {
      return {
        configured: true,
        connected: false,
        message: `Supabase erreur: ${error.message}`
      };
    }
    return { configured: true, connected: true, message: 'connecte' };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Erreur inconnue';
    return {
      configured: true,
      connected: false,
      message: `Connexion echouee: ${message}`
    };
  }
}
