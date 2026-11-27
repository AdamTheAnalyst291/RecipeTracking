import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const page = (name: string) => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig({
  plugins: [react()],
  // redirect.html is MSAL's redirect bridge (src/redirectBridge.ts), built as its own page.
  build: { rollupOptions: { input: { main: page("index.html"), redirect: page("redirect.html") } } },
});
