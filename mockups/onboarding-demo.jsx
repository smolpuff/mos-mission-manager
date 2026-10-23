import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import InterfaceTour from '../renderer/src/components/InterfaceTour';
import { createDemoBridge } from './demo-bridge.js';
import './onboarding-demo.css';

const setupPreview = new URLSearchParams(location.search).get('setup') === '1';
window.missionsDesktop = createDemoBridge({ setup: setupPreview });
await import('../renderer/main.jsx');

function TourDemo() {
  const [open, setOpen] = useState(!setupPreview);
  const [mode, setMode] = useState(null);
  const closeTour = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!open || !mode) return;
    // Only the isolated demo uses fixture mode handlers. Production previews
    // the real controls locally without saving or issuing runner commands.
    const timer = setInterval(() => {
      const button = document.querySelectorAll('.mission-modes button')[['auto', 'normal', 'mission'].indexOf(mode)];
      if (!button || button.disabled) return;
      if (!button.classList.contains('active')) button.click();
      clearInterval(timer);
    }, 60);
    return () => clearInterval(timer);
  }, [mode, open]);
  return <>
    {open && <InterfaceTour onClose={closeTour} onModePreview={setMode} />}
  </>;
}
createRoot(document.getElementById('demo-tour-root')).render(<TourDemo />);
