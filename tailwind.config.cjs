const forms = require('@tailwindcss/forms');
const typography = require('@tailwindcss/typography');
const aspectRatio = require('@tailwindcss/aspect-ratio');
const animate = require('tailwindcss-animate');

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    './index.html',
    './*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './contexts/**/*.{ts,tsx}',
    './config/**/*.{ts,tsx}',
    './hooks/**/*.{ts,tsx}',
    './i18n/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
    './services/**/*.{ts,tsx}',
    './utils/**/*.{ts,tsx}',
    '!./**/*.test.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        charcoal: '#1A1A2E',
        'electric-blue': '#00F0FF',
        'electric-green': '#2EE67C',
        'electric-purple': '#BB00FF',
        'light-charcoal': '#2C2C42',
        'mid-charcoal': '#3A3A52',
        'dark-charcoal': '#0F0F20',
        text: { light: '#E4E4F0', dark: '#9A9AB5' },
      },
      fontFamily: {
        headline: ['"Bebas Neue"', 'Impact', '"Arial Narrow"', 'sans-serif'],
        body: ['Lexend', 'system-ui', 'sans-serif'],
        serif: ['"Playfair Display"', 'Georgia', 'serif'],
        mono: ['"Space Mono"', 'ui-monospace', 'monospace'],
      },
      // These literal alpha utilities are already used by the existing screens.
      opacity: { 3: '.03', 6: '.06', 8: '.08', 15: '.15', 35: '.35', 45: '.45', 65: '.65', 85: '.85' },
    },
  },
  plugins: [forms, typography, aspectRatio, animate],
};
