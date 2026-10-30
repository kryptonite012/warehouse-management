/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'] },
      colors: {
        border: 'hsl(var(--border))',
        bg: 'hsl(var(--bg))',
        panel: 'hsl(var(--panel))',
        muted: 'hsl(var(--muted))',
        fg: 'hsl(var(--fg))',
        subtle: 'hsl(var(--subtle))',
        brand: { DEFAULT: 'hsl(var(--brand))', fg: 'hsl(var(--brand-fg))' },
        ok: 'hsl(var(--ok))',
        warn: 'hsl(var(--warn))',
        bad: 'hsl(var(--bad))',
      },
      borderRadius: { lg: '10px', md: '8px', sm: '6px' },
    },
  },
  plugins: [],
};
