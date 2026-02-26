import { notFound } from 'next/navigation';

export default function Debug() {
  if (process.env.NODE_ENV === 'production') {
    notFound();
  }

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
