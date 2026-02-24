"use client";

import type { CSSProperties } from 'react';

const GHOSTS = [
  { left: '6%', size: 46, duration: 17, delay: -2, alpha: 0.26 },
  { left: '18%', size: 28, duration: 13, delay: -7, alpha: 0.2 },
  { left: '34%', size: 52, duration: 21, delay: -4, alpha: 0.22 },
  { left: '51%', size: 34, duration: 16, delay: -10, alpha: 0.2 },
  { left: '67%', size: 58, duration: 22, delay: -3, alpha: 0.24 },
  { left: '80%', size: 30, duration: 14, delay: -8, alpha: 0.19 },
  { left: '91%', size: 42, duration: 19, delay: -5, alpha: 0.23 },
];

export default function GhostAmbient() {
  return (
    <div className="ghost-ambient" aria-hidden="true">
      {GHOSTS.map((ghost, index) => (
        <span
          key={index}
          className="ghost"
          style={
            {
              left: ghost.left,
              width: `${ghost.size}px`,
              height: `${ghost.size * 1.2}px`,
              animationDuration: `${ghost.duration}s`,
              animationDelay: `${ghost.delay}s`,
              opacity: ghost.alpha,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}
