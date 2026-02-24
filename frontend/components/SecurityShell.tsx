"use client";

import { useEffect, useMemo, useState } from 'react';

type Props = {
  userId: string;
  children: React.ReactNode;
};

export default function SecurityShell({ userId, children }: Props) {
  const [hidden, setHidden] = useState(false);
  const [manualLock, setManualLock] = useState(false);

  useEffect(() => {
    const lock = () => setHidden(true);
    const onVisibility = () => setHidden(document.visibilityState !== 'visible');
    const onBlur = () => setHidden(true);
    const onFocus = () => setHidden(document.visibilityState !== 'visible');
    const onPageHide = () => setHidden(true);
    const onResize = () => setHidden(true);
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const blockedCombo = (event.ctrlKey || event.metaKey) && ['c', 'v', 'x', 'p', 's'].includes(key);
      if (blockedCombo) event.preventDefault();
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    window.addEventListener('beforeprint', lock);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      window.removeEventListener('beforeprint', lock);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const wm = useMemo(() => `ghost:${userId.slice(0, 8)}`, [userId]);
  const isMasked = hidden || manualLock;

  return (
    <div
      className="security-shell"
      onCopy={(e) => e.preventDefault()}
      onPaste={(e) => e.preventDefault()}
      onCut={(e) => e.preventDefault()}
      onDrop={(e) => e.preventDefault()}
      onDragStart={(e) => e.preventDefault()}
    >
      <div className="watermark">{wm}</div>
      <div className="watermark-grid" aria-hidden="true">
        <span>{wm}</span>
        <span>{wm}</span>
        <span>{wm}</span>
        <span>{wm}</span>
      </div>
      {isMasked && (
        <div className="privacy-mask">
          <button
            type="button"
            className="ghost-btn"
            onClick={() => {
              setHidden(false);
              setManualLock(false);
            }}
          >
            Unlock secure view
          </button>
        </div>
      )}
      <button type="button" className="ghost-btn lock-toggle" onClick={() => setManualLock((v) => !v)}>
        {manualLock ? 'Unlock' : 'Lock'}
      </button>
      <div className={isMasked ? 'blurred' : ''}>{children}</div>
    </div>
  );
}
