import { glob } from "astro/loaders";
import { defineCollection } from "astro:content";
import { validateExamDirectories } from "./utils/examDirectories";
import { examFrontmatterSchema } from "./utils/examFrontmatter";

validateExamDirectories();

const exams = defineCollection({
    loader: glob({
        pattern: "*/index.mdx",
        base: "./exams",
        generateId: ({ entry }) => entry.replace(/\/index\.mdx$/, ""),
    }),
    schema: examFrontmatterSchema,
});
export const collections = { exams };
