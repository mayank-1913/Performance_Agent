/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        /* --------------------------------------------------------------
         * Light-theme palette.
         *
         * `slate` is intentionally REMAPPED (inverted from Tailwind's
         * default) so that all pre-existing utility usage in the app
         * stays semantically correct without touching every file:
         *   - text-slate-100 / -200 / -300 → readable dark text
         *   - text-slate-400 / -500        → muted body/label text
         *   - bg-slate-800 / -900 / -950   → light card / row surfaces
         *   - border-slate-700 / -800      → subtle light gray borders
         *   - hover:bg-slate-800/60 etc.   → soft light hover overlays
         *
         * Anything that was "darker" in the old dark theme becomes
         * "lighter" in this light theme, and vice versa. Numbers still
         * increase from lightest→darkest — they've just been re-anchored
         * to the light-theme range.
         * ------------------------------------------------------------ */
        slate: {
          50:  '#ffffff',
          100: '#111827', // primary text (near-black)
          200: '#1f2937', // strong body text
          300: '#374151', // subtitle / secondary text
          400: '#6b7280', // muted text
          500: '#9ca3af', // very muted / placeholder
          600: '#d1d5db', // subtle divider
          700: '#e5e7eb', // border
          800: '#f3f4f6', // panel / hover surface
          900: '#f8fafc', // page-adjacent surface
          950: '#ffffff', // deepest = pure white card
        },
        /* Surface tokens for new usage — semantic light-theme names. */
        surface: {
          page:    '#f8fafc', // page background (very light gray)
          panel:   '#ffffff', // cards / panels
          raised:  '#ffffff', // slightly elevated surfaces
          subtle:  '#f3f4f6', // subtle panels / hover
          muted:   '#e5e7eb', // muted background chip
          border:  '#e5e7eb', // default border
          divider: '#eef2f6', // very light divider
        },
        /* Text semantic tokens. */
        ink: {
          950: '#0f172a',
          900: '#111827', // primary text
          800: '#1f2937',
          700: '#374151', // secondary
          600: '#4b5563',
          500: '#6b7280', // muted
          400: '#9ca3af',
          300: '#d1d5db',
        },
        /* Brand — indigo primary + blue accent, matching the reference. */
        brand: {
          50:  '#eef2ff',
          100: '#e0e7ff',
          200: '#c7d2fe',
          300: '#a5b4fc',
          400: '#818cf8',
          500: '#6366f1', // primary indigo
          600: '#4f46e5',
          700: '#4338ca',
          800: '#3730a3',
          900: '#312e81',
        },
        accent: {
          blue:  '#3b82f6',
          indigo:'#6366f1',
        },
        /* Soft pastel status colors from the reference image. */
        success: {
          50:  '#ecfdf5',
          100: '#d1fae5',
          500: '#10b981',
          600: '#059669',
          700: '#047857',
        },
        warning: {
          50:  '#fffbeb',
          100: '#fef3c7',
          500: '#f59e0b',
          600: '#d97706',
          700: '#b45309',
        },
        danger: {
          50:  '#fef2f2',
          100: '#fee2e2',
          500: '#ef4444',
          600: '#dc2626',
          700: '#b91c1c',
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
        display: [
          'Manrope',
          'Inter',
          'ui-sans-serif',
          'system-ui',
          'sans-serif',
        ],
        num: ['Outfit', 'Inter', 'ui-sans-serif', 'sans-serif'],
      },
      backgroundImage: {
        /* Reserved for compatibility with any existing `bg-accent-gradient`
           utility uses (e.g. the brand mark). Kept subtle for the light
           theme — indigo → blue. */
        'accent-gradient':
          'linear-gradient(135deg, #6366f1 0%, #3b82f6 100%)',
        'accent-gradient-soft':
          'linear-gradient(135deg, rgba(99,102,241,0.10) 0%, rgba(59,130,246,0.10) 100%)',
      },
      boxShadow: {
        /* Card / button shadows tuned for the light theme. */
        card: '0 1px 2px 0 rgba(15, 23, 42, 0.04), 0 1px 3px 0 rgba(15, 23, 42, 0.06)',
        'card-hover':
          '0 4px 6px -1px rgba(15, 23, 42, 0.06), 0 2px 4px -1px rgba(15, 23, 42, 0.05)',
        glow: '0 6px 20px -6px rgba(99, 102, 241, 0.35)',
        'glow-soft': '0 4px 14px -4px rgba(99, 102, 241, 0.25)',
        'inner-glow': 'inset 0 1px 0 0 rgba(255,255,255,0.6)',
      },
      borderRadius: {
        xl: '0.875rem',
        '2xl': '1.125rem',
      },
    },
  },
  plugins: [],
};
