/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "#f6f8fb",
        ink: "#121826",
        muted: "#65758b",
        line: "#d9e2ec",
        brand: "#0f766e",
        signal: "#d97706",
      },
      boxShadow: {
        panel: "0 1px 3px rgba(17, 24, 39, 0.08), 0 12px 30px rgba(17, 24, 39, 0.06)",
        node: "0 10px 30px rgba(15, 23, 42, 0.12)",
      },
    },
  },
  plugins: [],
};
