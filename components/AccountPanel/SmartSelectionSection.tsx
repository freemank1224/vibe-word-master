import React from 'react';
import { ToggleSwitch } from '../ToggleSwitch';
import { HoverTranslationText } from '../HoverTranslationText';

interface SmartSelectionSectionProps {
  enabled: boolean;
  onToggle: () => void;
}

export const SmartSelectionSection: React.FC<SmartSelectionSectionProps> = ({ enabled, onToggle }) => {
  return (
    <div className="space-y-4">
      <h3 className="font-headline text-lg text-text-dark tracking-[0.2em] uppercase"><HoverTranslationText text="Smart Selection" translation="智能选择" /></h3>
      <div className="bg-dark-charcoal p-5 rounded-3xl border border-mid-charcoal/30 flex items-center justify-between">
        <div>
          <div className="text-white font-mono text-sm mb-1"><HoverTranslationText text="Smart Selection Assistant" translation="智能选择助手" /></div>
          <div className="text-[10px] text-text-light font-mono max-w-[200px] leading-tight">
            OFF: Random selection from checked words<br/>
            ON: Intelligent selection based on error history & forgetting curve
          </div>
        </div>
        <ToggleSwitch
          checked={enabled}
          onChange={onToggle}
          ariaLabel="Toggle smart selection"
        />
      </div>
    </div>
  );
};
