"use client";

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSession } from '@/lib/session';

const STEPS = [
  { label: 'Sécurisation de votre IP', icon: 'shield' },
  { label: 'Chiffrement des données', icon: 'lock' },
  { label: 'Génération des clés E2E', icon: 'key' },
  { label: 'Connexion au serveur sécurisé', icon: 'server' },
  { label: 'Session protégée', icon: 'check' },
];

const STEP_DURATION = 900;

export default function SecurePage() {
  const router = useRouter();
  const [currentStep, setCurrentStep] = useState(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const session = getSession();
    if (!session) {
      router.replace('/login');
      return;
    }
  }, [router]);

  useEffect(() => {
    if (currentStep < STEPS.length) {
      const timer = window.setTimeout(() => {
        setCurrentStep((s) => s + 1);
      }, STEP_DURATION);
      return () => window.clearTimeout(timer);
    }
    setDone(true);
    const redirect = window.setTimeout(() => {
      router.replace('/chat');
    }, 600);
    return () => window.clearTimeout(redirect);
  }, [currentStep, router]);

  const progress = Math.min((currentStep / STEPS.length) * 100, 100);

  return (
    <main className="secure-screen">
      <div className="secure-container">
        <div className={`secure-shield ${done ? 'done' : ''}`}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2l7.5 3.5v5c0 5.25-3.19 10.15-7.5 11.5C7.69 20.65 4.5 15.75 4.5 10.5v-5L12 2Zm0 2.2L6.5 7v3.5c0 4.25 2.58 8.22 5.5 9.45 2.92-1.23 5.5-5.2 5.5-9.45V7L12 4.2Z" />
          </svg>
          <div className="secure-shield-pulse" />
        </div>

        <h1 className="secure-title">Ghost Secure</h1>

        <div className="secure-steps">
          {STEPS.map((step, i) => (
            <div
              key={step.label}
              className={`secure-step ${i < currentStep ? 'completed' : ''} ${i === currentStep ? 'active' : ''}`}
            >
              <div className="secure-step-icon">
                {i < currentStep ? (
                  <CheckIcon />
                ) : i === currentStep ? (
                  <span className="secure-spinner" />
                ) : (
                  <span className="secure-dot" />
                )}
              </div>
              <span className="secure-step-label">{step.label}</span>
            </div>
          ))}
        </div>

        <div className="secure-progress-track">
          <div className="secure-progress-bar" style={{ width: `${progress}%` }} />
        </div>

        {done && <p className="secure-ready">Prêt</p>}
      </div>
    </main>
  );
}

function CheckIcon() {
  return (
    <svg className="secure-check-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z" />
    </svg>
  );
}
