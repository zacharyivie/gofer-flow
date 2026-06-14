/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "rgb(var(--color-canvas) / <alpha-value>)",
        ink: "rgb(var(--color-ink) / <alpha-value>)",
        muted: "rgb(var(--color-muted) / <alpha-value>)",
        line: "rgb(var(--color-line) / <alpha-value>)",
        brand: "rgb(var(--color-brand) / <alpha-value>)",
        signal: "rgb(var(--color-signal) / <alpha-value>)",
      },
      boxShadow: {
        panel: "0 1px 3px rgba(17, 24, 39, 0.08), 0 12px 30px rgba(17, 24, 39, 0.06)",
        node: "0 10px 30px rgba(15, 23, 42, 0.12)",
      },
    },
  },
  plugins: [],
};
