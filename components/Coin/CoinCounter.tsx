import React, { useEffect, useRef, useState } from 'react';
import { CoinIcon } from './CoinIcon';

interface CoinCounterProps {
  balance: number;
}

/**
 * Compact coin balance widget for the header. Briefly pulses
 * (scale + amber glow) whenever the balance increases so the user
 * gets immediate visual feedback when they earn coins.
 */
export const CoinCounter: React.FC<CoinCounterProps> = ({ balance }) => {
  const prevRef = useRef(balance);
  const [pulse, setPulse] = useState(false);

  useEffect(() => {
    // Only pulse on genuine increases (not the initial load from -1 → real value)
    if (balance > prevRef.current && prevRef.current >= 0) {
      setPulse(true);
      const t = window.setTimeout(() => setPulse(false), 600);
      prevRef.current = balance;
      return () => window.clearTimeout(t);
    }
    prevRef.current = balance;
  }, [balance]);

  return (
    <div
      className={`flex items-center gap-1.5 rounded-full border px-3 py-1 font-mono text-sm transition-all duration-300 ${
        pulse
          ? 'border-amber-400/60 bg-amber-400/10 text-amber-300 scale-125 shadow-[0_0_20px_rgba(251,191,36,0.4)]'
          : 'border-mid-charcoal bg-black/30 text-amber-200/90'
      }`}
      title="Coin balance"
    >
      <CoinIcon fontSize="18px" />
      <span className="tabular-nums">{balance < 0 ? '…' : balance}</span>
    </div>
  );
};
