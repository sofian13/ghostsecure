# Setup demo Vercel + Supabase

1. Ouvre Supabase SQL Editor et execute le script [`/supabase/schema.sql`](../supabase/schema.sql).
2. Dans Vercel, ajoute:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
3. Redeploie le frontend.

Notes:
- Le projet ne depend plus du backend Symfony pour login/chat/call signaling.
- Le realtime des messages utilise la table `message` via Supabase Realtime.
- Ce mode est pour demo. En production, active RLS + vraies policies.
