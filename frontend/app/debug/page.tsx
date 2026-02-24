export default function Debug() {
  return (
    <pre>
      {JSON.stringify(
        {
          supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
          hasAnonKey: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        },
        null,
        2
      )}
    </pre>
  );
}
