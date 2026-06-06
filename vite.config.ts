import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/tree-chopper-v2/",
  plugins: [react()],
});
