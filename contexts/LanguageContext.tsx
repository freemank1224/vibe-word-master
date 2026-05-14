import React, { createContext, useContext, useState } from 'react';

export type Language = 'en' | 'zh';

interface LanguageContextType {
  language: Language;
  toggleLanguage: () => void;
  setLanguage: (lang: Language) => void;
  isZh: boolean;
}

const LanguageContext = createContext<LanguageContextType>({
  language: 'en',
  toggleLanguage: () => {},
  setLanguage: () => {},
  isZh: false,
});

export const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [language, setLanguage] = useState<Language>('en');

  const toggleLanguage = () => {
    const next: Language = language === 'en' ? 'zh' : 'en';
    setLanguage(next);
    localStorage.setItem('vibe_language', next);
  };

  return (
    <LanguageContext.Provider value={{ language, toggleLanguage, setLanguage, isZh: language === 'zh' }}>
      {children}
    </LanguageContext.Provider>
  );
};

export const useLanguage = () => useContext(LanguageContext);
