import { glob } from "astro/loaders";
import { defineCollection } from "astro:content";
import { z } from "astro/zod";
import { validateExamDirectories } from "./utils/examDirectories";

const SCHOOLS = [
    "人工智能学院",
    "人文学院",
    "信息与通信工程学院",
    "卓越工程师学院",
    "国际学院",
    "数字媒体与设计艺术学院",
    "数学科学学院",
    "智能工程与自动化学院",
    "未来学院",
    "物理科学与技术学院",
    "玛丽女王海南学院",
    "理学院",
    "电子工程学院",
    "经济管理学院",
    "网络空间安全学院",
    "计算机学院",
    "集成电路学院",
    "马克思主义学院",
] as const;
const timePattern = /^(\d{4})-(\d{4})学年第[一二]学期$/;

validateExamDirectories();

const exams = defineCollection({
    loader: glob({
        pattern: "*/index.mdx",
        base: "./exams",
        generateId: ({ entry }) => entry.replace(/\/index\.mdx$/, ""),
    }),
    schema: z.object({
        时间: z.string()
            .regex(timePattern)
            .refine((value) => {
                const match = value.match(timePattern);
                if (!match)
                    return false;
                const year = [Number(match[1]), Number(match[2])];
                return year[1] === year[0] + 1;
            }),
        阶段: z.enum(["期中", "期末"]),
        类型: z.enum(["本科", "研究生"]),
        科目: z.string(),
        学院: z.array(z.enum(SCHOOLS)).optional(),
        来源: z.string().regex(/^[0-9a-f]{32}$/).optional(),
        答案完成度: z.enum(["残缺", "完整", "完整可靠"]).optional(),
    }),
});
export const collections = { exams };
