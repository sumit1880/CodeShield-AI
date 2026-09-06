/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#12100D',
        panel: '#1A1713',
        'panel-alt': '#211D18',
        ink: '#EDE7DC',
        'ink-dim': '#A79C89',
        'ink-faint': '#6E6555',
        line: '#332D24',
        'line-bright': '#4A4232',
        accent: '#E8A33D',
        'accent-dim': '#8C6A2C',
        'accent-ink': '#1A1409',
        critical: '#E5484D',
        high: '#E8843D',
        medium: '#D9BC3F',
        low: '#5FA8D3',
        info: '#7C8A99',
        confirmed: '#4FAE7C'
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        sans: ['"IBM Plex Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif']
      },
      backgroundImage: {
        grid:
          'linear-gradient(to right, rgba(237,231,220,0.035) 1px, transparent 1px), linear-gradient(to bottom, rgba(237,231,220,0.035) 1px, transparent 1px)'
      },
      backgroundSize: {
        grid: '28px 28px'
      },
      keyframes: {
        scan: {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100%)' }
        },
        blink: {
          '0%, 49%': { opacity: '1' },
          '50%, 100%': { opacity: '0' }
        },
        stagger: {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' }
        }
      },
      animation: {
        scan: 'scan 2.4s linear infinite',
        blink: 'blink 1.1s step-start infinite',
        stagger: 'stagger 0.28s ease-out both'
      }
    }
  },
  plugins: []
};
