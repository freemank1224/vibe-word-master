import { useLanguage } from '../contexts/LanguageContext';
import { translations } from '../i18n/translations';

export const useT = () => {
  const { language } = useLanguage();
  return translations[language];
};
