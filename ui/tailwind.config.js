/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        gstack: {
          bg: '#0a0a0a',
          surface: '#0f0f0f',
          border: '#222',
          text: '#e0e0e0',
          muted: '#888',
          dim: '#666',
          accent: '#4ade80',
          'accent-bg': '#0a2a14',
          danger: '#f87171',
          'danger-bg': '#2a0a0a',
          info: '#60a5fa',
          'info-bg': '#0a1a2a',
          warning: '#fbbf24',
          'warning-bg': '#2a1a0a',
        },
      },
      fontFamily: {
        mono: ["'SF Mono'", "'Fira Code'", 'monospace'],
      },
    },
  },
  plugins: [],
};
