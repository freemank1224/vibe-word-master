import React from 'react';

interface ToggleSwitchProps {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  sizeClassName?: string;
  trackOnClassName?: string;
  trackOffClassName?: string;
  thumbClassName?: string;
}

export const ToggleSwitch: React.FC<ToggleSwitchProps> = ({
  checked,
  onChange,
  disabled = false,
  ariaLabel,
  className = '',
  sizeClassName = 'w-14 h-8',
  trackOnClassName = 'bg-electric-blue',
  trackOffClassName = 'bg-mid-charcoal',
  thumbClassName = 'w-6 h-6 bg-white',
}) => {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={onChange}
      disabled={disabled}
      className={`${sizeClassName} rounded-full transition-colors relative ${checked ? trackOnClassName : trackOffClassName} ${disabled ? 'opacity-60 cursor-not-allowed' : ''} ${className}`.trim()}
    >
      <div
        className={`absolute top-1 ${thumbClassName} rounded-full transition-all duration-200 ${checked ? 'right-1' : 'left-1'}`}
      />
    </button>
  );
};
