/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: { extend: { colors: { brand: { DEFAULT: '#16a34a', dark: '#15803d', soft: '#dcfce7' } } } },
  plugins: [],
};
