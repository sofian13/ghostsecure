export default function Debug() {
  return (
    <pre>
      {JSON.stringify(
        {
          url: process.env.NEXT_PUBLIC_SUPABASE_URL,
          hasAnon: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        },
        null,
        2
      )}
    </pre>
  );
}
