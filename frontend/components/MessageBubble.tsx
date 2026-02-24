"use client";

import { useEffect, useState } from 'react';

type Props = {
  text: string;
  mine: boolean;
  expiresAt: string | null;
};

export default function MessageBubble({ text, mine, expiresAt }: Props) {
  const [revealed, setRevealed] = useState(false);
  const [isExpired, setIsExpired] = useState(false);

  useEffect(() => {
    if (!expiresAt) return;
    const deadline = new Date(expiresAt).getTime();
    const update = () => setIsExpired(Date.now() > deadline);
    update();
    const id = window.setInterval(update, 1000);
    return () => window.clearInterval(id);
  }, [expiresAt]);

  if (isExpired) {
    return <div className={`message-bubble ${mine ? 'mine' : 'peer'}`}>[message supprimé]</div>;
  }

  return (
    <button
      type="button"
      className={`message-bubble ${mine ? 'mine' : 'peer'}`}
      onClick={() => setRevealed((v) => !v)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {revealed ? text : 'tap to reveal'}
    </button>
  );
}
