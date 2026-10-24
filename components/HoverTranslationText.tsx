import React from 'react';
import { useLanguage } from '../contexts/LanguageContext';

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
  const { isZh } = useLanguage();

  return <span className={`text-inherit ${className}`}>{isZh ? translation : text}</span>;
};
