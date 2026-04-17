---
applyTo: "exams/**"
---

Review these files against the exam editing rules in [src/others/guide.mdx](../../src/others/guide.mdx).

Write all review summaries, findings, suggestions, and comments in Chinese.

Check whether the exam structure is correct. Every exam should use `exams/<试卷名>/index.mdx` and keep any related image or audio files in that same directory. Files under `public/` should not be introduced for exam assets.

Check whether the exam filename or directory name is precise, unique, and uses the repository naming convention.

Check whether frontmatter is complete and normalized. `时间` should use the `xxxx-yyyy学年第[一/二]学期` format. `科目` should use the official Chinese course name. `阶段` should be `期中` or `期末`. `类型` should be `本科` or `研究生`. Optional fields such as `学院`, `来源`, and `答案完成度` should still follow the guide if present.

Check whether the body uses standard Markdown and the repository's supported MDX components instead of custom JSX, scripts, or inline styles.

Check whether heading structure matches the guide: major questions normally use `##`, smaller subquestions use `###` only when appropriate, and choice / blank / judgment questions should often be expressed as lists instead of overusing headings.

Check whether assets referenced by `Figure` or `Audio` live beside the corresponding `index.mdx` in the same exam directory, and whether the references use the local file names expected by that layout.

Prefer actionable comments tied to rendering or editorial correctness. Avoid low-value wording suggestions unless the wording creates ambiguity in the exam content itself.
