import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const examsDir = resolve("exams");

type ExamDirectory = {
    name: string;
    path: string;
};

const isIgnoredEntry = (name: string) => name.startsWith(".");

export function validateExamDirectories() {
    const entries = readdirSync(examsDir, { withFileTypes: true });

    for (const entry of entries) {
        if (isIgnoredEntry(entry.name)) continue;

        const entryPath = join(examsDir, entry.name);
        if (!entry.isDirectory()) {
            const examName = entry.name.replace(/\.mdx$/, "");
            throw new Error(
                `试题目录结构无效：${relative(process.cwd(), entryPath)}。` +
                    `每份试题都必须使用 exams/${examName}/index.mdx 的目录结构。`,
            );
        }

        const indexPath = join(entryPath, "index.mdx");
        try {
            if (!statSync(indexPath).isFile()) {
                throw new Error("index.mdx 不是文件");
            }
        } catch {
            throw new Error(
                `试题目录结构无效：缺少 ${relative(process.cwd(), indexPath)}。` +
                    "每个试题目录下都必须包含 index.mdx。",
            );
        }
    }
}

export function getExamDirectories(): ExamDirectory[] {
    validateExamDirectories();

    return readdirSync(examsDir, { withFileTypes: true })
        .filter((entry) => !isIgnoredEntry(entry.name) && entry.isDirectory())
        .map((entry) => ({
            name: entry.name,
            path: join(examsDir, entry.name),
        }));
}
