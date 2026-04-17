import { defineConfig } from "eslint/config";
import js from "@eslint/js";
import eslintPluginAstro from "eslint-plugin-astro";
import * as mdx from "eslint-plugin-mdx";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
    {
        ignores: ["dist/**", ".astro/**", "node_modules/**", "vscode-extension/dist/**"],
    },
    {
        files: ["**/*.{js,cjs,mjs,ts}"],
        extends: [js.configs.recommended, ...tseslint.configs.recommended],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            globals: {
                ...globals.browser,
                ...globals.node,
            },
        },
        rules: {
            "@typescript-eslint/no-explicit-any": "off",
            "no-empty": "off",
            "no-var": "off",
        },
    },
    ...eslintPluginAstro.configs.recommended,
    {
        files: ["**/*.astro"],
        rules: {
            "astro/no-set-html-directive": "off",
            "no-empty": "off",
            "no-var": "off",
        },
    },
    {
        ...mdx.flat,
        files: ["**/*.{md,mdx}"],
        processor: mdx.createRemarkProcessor({
            remarkConfigPath: ".remarkrc.json",
            ignoreRemarkConfig: false,
            lintCodeBlocks: false,
        }),
    },
    {
        ...mdx.flatCodeBlocks,
        files: ["**/*.{md,mdx}"],
    },
);
