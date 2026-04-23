import * as vscode from "vscode";

export const SHELL_INTEGRATION_WAIT_MS = 1_000;
export const SERVER_RECONNECT_TIMEOUT_MS = 3_000;
export const SERVER_RECONNECT_INTERVAL_MS = 500;
export const SERVER_DETECTION_TIMEOUT_MS = 90_000;
export const SERVER_PING_INTERVAL_MS = 1_500;
export const PREVIEW_SERVER_HOST = "127.0.0.1";
export const PREVIEW_SERVER_START_PORT = 4_321;
export const PREVIEW_SERVER_PORT_SEARCH_LIMIT = 20;
export const UNRESOLVED_SERVER_ORIGIN_LABEL = "等待终端输出解析";
export const CREATE_EXAM_PAGE_CONTAINER_ID = "byrdocsWiki";
export const PREVIEW_TERMINAL_NAME = "BYR Docs Wiki Preview";
export const CREATE_EXAM_PAGE_VIEW_ID = "byrdocsWiki.createExamPageView";
export const SUPPORTED_EXTENSIONS = new Set([".astro", ".mdx"]);
export const EXAM_TIME_PATTERN = /^(\d{4})-(\d{4})学年第([一二])学期$/u;
export const EXAM_NAME_PATTERN =
  /^(\d{2})-(\d{2})-(1|2)-(.+)-(期中|期末)(?:（(.+)）)?$/u;
export const DEFAULT_EXAM_TEMPLATE = `---
时间: {{时间}}
科目: {{科目}}
阶段: {{阶段}}
类型: {{类型}}
{{学院块}}{{来源块}}{{答案完成度块}}---

## 一、

### 1.

在此录入题目内容。

<Solution>
在此录入答案或解析。
</Solution>
`;

export const DOCUMENT_SELECTOR: readonly vscode.DocumentFilter[] = [
  { scheme: "file", pattern: "**/*.mdx" },
  { scheme: "file", pattern: "**/*.astro" },
  { scheme: "untitled", language: "markdown" },
  { scheme: "untitled", language: "mdx" },
  { scheme: "untitled", language: "astro" },
];

export const SEMANTIC_LEGEND = new vscode.SemanticTokensLegend(
  ["class", "property", "operator", "keyword"],
  [],
);
