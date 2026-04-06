import React from 'react';

interface HoverTranslationTextProps {
  text: string;
  translation: string;
  className?: string;
}

export const HoverTranslationText: React.FC<HoverTranslationTextProps> = ({
  text,
  translation,
  className = ''
}) => {
  return (
    <span className={`group/translation relative inline-flex cursor-help ${className}`}>
      <span>{text}</span>
      <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-3 w-max max-w-[18rem] -translate-x-1/2 rounded-2xl border border-red-500/20 bg-[#120b0d]/95 px-4 py-2 text-center text-xs font-body leading-relaxed text-red-100 opacity-0 shadow-[0_12px_30px_rgba(0,0,0,0.35)] transition-all duration-200 group-hover/translation:translate-y-1 group-hover/translation:opacity-100">
        {translation}
      </span>
    </span>
  );
};
