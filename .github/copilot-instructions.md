When reviewing pull requests in this repository, prioritize correctness of exam content structure and repository conventions over generic style advice.

Write all review summaries, findings, suggestions, and comments in Chinese.

Treat [src/others/guide.mdx](../src/others/guide.mdx) as the source of truth for content rules, and use [src/others/test.mdx](../src/others/test.mdx) as a concrete example of valid exam MDX usage.

For exam files under `exams/`, check that every exam uses the directory layout `exams/<试卷名>/index.mdx`. Any related image or audio assets should live as sibling files in that same directory. Pay special attention to file names following the `学年开始-学年结束-学期-科目-阶段（备注）` convention.

For any exam MDX file, check that frontmatter keys and values match the guide. Pay special attention to `时间` format, `科目` using the official Chinese full name, `阶段` being `期中` or `期末`, and `类型` being `本科` or `研究生`.

For exam content, prefer findings only when the change breaks the guide or likely harms reader experience. Flag custom scripts, custom styles, unsupported components, incorrect heading hierarchy, unnecessary photos instead of typed content, and misuse of repository components such as `Blank`, `Slot`, `Choices`, `Option`, `Solution`, `Figure`, and `Audio`.

For exam asset files, check that they live beside the corresponding `index.mdx` inside the same exam directory instead of under `public/`, and that `Figure` / `Audio` references use that local exam-directory layout.

For site code under `src/`, `astro.config.mts`, and related configuration files, review as an Astro + TypeScript project. Prefer concrete comments about regressions, broken routes, invalid MDX integration, content rendering issues, or build/check failures over subjective refactoring suggestions.

Before suggesting major structural changes, verify that the proposal is compatible with the existing editor workflow for non-programmer contributors. Changes that make exam editing harder should be treated as a risk.

If a pull request only updates exam content, avoid requesting engineering-heavy refactors. Focus on whether the content is renderable, follows the editing guide, and will pass `pnpm lint`, `pnpm check`, and `pnpm build`.
