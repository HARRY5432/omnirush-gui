import react from "@vitejs/plugin-react"
import { defaultClientConditions, defineConfig } from "vite"
import { viteSingleFile } from "vite-plugin-singlefile"

const app = (process.env.OMNIRUSH_MCP_APP ?? "skill-created").trim()

export default defineConfig({
  plugins: [react(), viteSingleFile({ removeViteModuleLoader: true })],
  // Workspace packages (@omnirush/types) from their source: their dist/ exists only after a separate build.
  resolve: { conditions: ["development", ...defaultClientConditions] },
  build: {
    cssCodeSplit: false,
    // The build script stages each app into its own scratch outDir and
    // renames artifacts into dist atomically, so nothing here may clear
    // shared output that concurrent consumers are importing.
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: `${app}.html`,
    },
  },
})
