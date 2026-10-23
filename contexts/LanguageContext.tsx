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
  const [language, updateLanguage] = useState<Language>(() => {
    try { return localStorage.getItem('vibe_language') === 'zh' ? 'zh' : 'en'; }
    catch { return 'en'; }
  });

  const setLanguage = (next: Language) => {
    updateLanguage(next);
    try { localStorage.setItem('vibe_language', next); } catch { /* Keep the current session usable. */ }
  };

  const toggleLanguage = () => {
    const next: Language = language === 'en' ? 'zh' : 'en';
    setLanguage(next);
  };

  return (
    <LanguageContext.Provider value={{ language, toggleLanguage, setLanguage, isZh: language === 'zh' }}>
      {children}
    </LanguageContext.Provider>
  );
};

export const useLanguage = () => useContext(LanguageContext);
