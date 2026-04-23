// @ts-check
import mdx from "@astrojs/mdx";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import remarkChoices from "./src/plugins/remarkChoices";
import viteExamAssets from "./src/plugins/viteExamAssets";

type AstroConfig = Parameters<typeof defineConfig>[0];
type AstroVitePlugins = NonNullable<NonNullable<AstroConfig["vite"]>["plugins"]>;

// @tailwindcss/vite resolves to a distinct Vite type instance; normalize it here.
const vitePlugins = [...tailwindcss(), viteExamAssets()] as unknown as AstroVitePlugins;

// https://astro.build/config
export default defineConfig({
    site: "https://wiki.byrdocs.org",
    integrations: [mdx()],
    markdown: {
        remarkPlugins: [remarkMath, remarkChoices],
        rehypePlugins: [rehypeKatex],
    },
    vite: {
        plugins: vitePlugins,
    },
});
