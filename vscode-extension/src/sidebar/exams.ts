import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  ANSWER_COMPLETENESS_VALUES,
  CONTENT_CONFIG_PATH,
  DEFAULT_TEMPLATE_PATH,
  STAGE_VALUES,
  TERM_VALUES,
  TYPE_VALUES,
  type AnswerCompletenessValue,
  type ExamTypeValue,
  type StageValue,
  type TermValue,
} from "../lib/metadata";
import {
  DEFAULT_EXAM_TEMPLATE,
  EXAM_NAME_PATTERN,
  EXAM_TIME_PATTERN,
} from "../constants";
import { toStringValue, asRecord } from "../utils/common";
import { getWikiWorkspaceFolderForUri } from "../workspace";
import type { ExamPreviewManager } from "../preview/manager";
import type {
  CreateExamPageDefaults,
  CreateExamPageNormalizedPayload,
  CreateExamPageResult,
  SidebarExamEntry,
} from "./types";

export async function createExamPageFromPayload(
  rawPayload: unknown,
  previewManagerInstance: ExamPreviewManager,
): Promise<CreateExamPageResult> {
  const workspaceFolder = getWikiWorkspaceFolderForUri();
  if (!workspaceFolder) {
    throw new Error("当前工作区不是 byrdocs-wiki 项目。");
  }

  const schoolOptions = readSchoolOptions(workspaceFolder);
  const payload = normalizeCreateExamPayload(rawPayload, schoolOptions);
  const examsDirectory = path.join(workspaceFolder.uri.fsPath, "exams");
  const examDirectory = path.join(examsDirectory, payload.examName);
  const filePath = path.join(examDirectory, "index.mdx");

  if (fs.existsSync(filePath)) {
    const choice = await vscode.window.showWarningMessage(
      `页面已存在：${payload.examName}`,
      "打开现有页面",
      "添加备注",
    );
    const fileUri = vscode.Uri.file(filePath);
    if (choice === "打开现有页面") {
      await previewManagerInstance.showSourceDocument(fileUri, {
        preserveFocus: true,
      });
      await previewManagerInstance.preview(fileUri, {
        focusPreview: true,
      });
      return {
        kind: "openedExisting",
        examName: payload.examName,
        fileUri,
      };
    }

    if (choice === "添加备注") {
      return {
        kind: "focusRemark",
      };
    }

    return {
      kind: "cancelled",
    };
  }

  await fs.promises.mkdir(examDirectory, { recursive: false });
  const template = await readExamTemplate(workspaceFolder);
  const content = renderExamTemplate(template, payload);
  await fs.promises.writeFile(filePath, content, {
    encoding: "utf8",
    flag: "wx",
  });

  const fileUri = vscode.Uri.file(filePath);
  await previewManagerInstance.showSourceDocument(fileUri, {
    preserveFocus: true,
  });
  await previewManagerInstance.preview(fileUri, {
    focusPreview: true,
  });

  return {
    kind: "created",
    examName: payload.examName,
    fileUri,
  };
}

export function normalizeCreateExamPayload(
  rawPayload: unknown,
  schoolOptions: readonly string[],
): CreateExamPageNormalizedPayload {
  const payload = asRecord(rawPayload);
  const startYear = Number.parseInt(toStringValue(payload.startYear), 10);
  const term = toStringValue(payload.term);
  const subject = toStringValue(payload.subject).trim();
  const stage = toStringValue(payload.stage);
  const examType = toStringValue(payload.type);
  const source = toStringValue(payload.source).trim().toLowerCase();
  const answerCompleteness = toStringValue(payload.answerCompleteness).trim();
  const remark = normalizeRemark(toStringValue(payload.remark));
  const colleges = Array.isArray(payload.colleges)
    ? [...new Set(payload.colleges.map((item) => String(item).trim()).filter(Boolean))]
    : [];

  if (!Number.isInteger(startYear) || String(startYear).length !== 4) {
    throw new Error("开始年份必须是四位数字。");
  }
  const endYear = deriveAcademicEndYear(startYear);

  if (!TERM_VALUES.includes(term as TermValue)) {
    throw new Error("学期只能是 1 或 2。");
  }

  if (!subject) {
    throw new Error("课程名称不能为空。");
  }

  if (/[\\/:*?"<>|]/.test(subject)) {
    throw new Error("课程名称不能包含文件系统保留字符。");
  }

  if (remark && /[\\/:*?"<>|]/.test(remark)) {
    throw new Error("备注不能包含文件系统保留字符。");
  }

  if (!STAGE_VALUES.includes(stage as StageValue)) {
    throw new Error("阶段只能是“期中”或“期末”。");
  }

  if (!TYPE_VALUES.includes(examType as ExamTypeValue)) {
    throw new Error("类型只能是“本科”或“研究生”。");
  }

  for (const college of colleges) {
    if (!schoolOptions.includes(college)) {
      throw new Error(`无效学院：${college}`);
    }
  }

  if (source && !/^[0-9a-f]{32}$/.test(source)) {
    throw new Error("来源必须是 32 位小写 md5。");
  }

  if (
    answerCompleteness &&
    !ANSWER_COMPLETENESS_VALUES.includes(
      answerCompleteness as AnswerCompletenessValue,
    )
  ) {
    throw new Error("答案完成度必须是“残缺”“完整”或“完整可靠”。");
  }

  const shortStartYear = padAcademicYear(startYear);
  const shortEndYear = padAcademicYear(endYear);
  const time = `${startYear}-${endYear}学年第${term === "1" ? "一" : "二"}学期`;
  const examNameBase = `${shortStartYear}-${shortEndYear}-${term}-${subject}-${stage}`;
  const examName = remark ? `${examNameBase}（${remark}）` : examNameBase;

  return {
    source,
    subject,
    type: examType as ExamTypeValue,
    remark,
    phase: stage as StageValue,
    time,
    colleges,
    examName,
    answerCompleteness:
      (answerCompleteness as AnswerCompletenessValue | "") || "",
  };
}

export async function readExamTemplate(
  workspaceFolder: vscode.WorkspaceFolder,
): Promise<string> {
  const templatePath = path.join(
    workspaceFolder.uri.fsPath,
    DEFAULT_TEMPLATE_PATH,
  );
  try {
    return await fs.promises.readFile(templatePath, "utf8");
  } catch {
    return DEFAULT_EXAM_TEMPLATE;
  }
}

export function renderExamTemplate(
  template: string,
  payload: CreateExamPageNormalizedPayload,
): string {
  const collegeBlock = payload.colleges.length
    ? `学院:\n${payload.colleges.map((item) => `- ${item}`).join("\n")}\n`
    : "";
  const sourceBlock = payload.source ? `来源: ${payload.source}\n` : "";
  const answerCompletenessBlock = payload.answerCompleteness
    ? `答案完成度: ${payload.answerCompleteness}\n`
    : "";

  return template
    .replaceAll("{{时间}}", payload.time)
    .replaceAll("{{科目}}", payload.subject)
    .replaceAll("{{阶段}}", payload.phase)
    .replaceAll("{{类型}}", payload.type)
    .replaceAll("{{学院块}}", collegeBlock)
    .replaceAll("{{来源块}}", sourceBlock)
    .replaceAll("{{答案完成度块}}", answerCompletenessBlock)
    .replaceAll("{{目录名}}", payload.examName);
}

export function getDefaultCreateFormState(): CreateExamPageDefaults {
  const now = new Date();
  const month = now.getMonth() + 1;
  const startYear = now.getFullYear();
  return {
    startYear,
    term: month >= 2 && month <= 7 ? "2" : "1",
    stage: "期末",
    type: "本科",
    subject: "",
    remark: "",
    source: "",
    answerCompleteness: "",
  };
}

export function deriveAcademicEndYear(startYear: number): number {
  return startYear + 1;
}

export function formatAcademicYearLabel(startYear: number): string {
  return `${startYear}-${deriveAcademicEndYear(startYear)}`;
}

export function getAcademicYearStartOptions(): number[] {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1; // 1-indexed
  // The next academic year (starting in September) is only available from August onwards
  const maxStartYear = currentMonth >= 8 ? currentYear : currentYear - 1;
  const options: number[] = [];
  for (let year = maxStartYear; year >= 2020; year -= 1) {
    options.push(year);
  }
  return options;
}

export function normalizeRemark(remark: string): string {
  return remark
    .trim()
    .replace(/^[（(]\s*/, "")
    .replace(/\s*[）)]$/, "")
    .trim();
}

export function padAcademicYear(year: number): string {
  return String(year).slice(-2).padStart(2, "0");
}

export function readSchoolOptions(
  workspaceFolder: vscode.WorkspaceFolder,
): string[] {
  const configPath = path.join(workspaceFolder.uri.fsPath, CONTENT_CONFIG_PATH);
  try {
    const source = fs.readFileSync(configPath, "utf8");
    const blockMatch = source.match(/const SCHOOLS = \[([\s\S]*?)\] as const;/);
    if (!blockMatch) {
      return [];
    }

    const schools: string[] = [];
    const schoolRegex = /"([^"]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = schoolRegex.exec(blockMatch[1] || ""))) {
      if (match[1]) {
        schools.push(match[1]);
      }
    }

    return schools;
  } catch {
    return [];
  }
}

export function readExamEntries(
  workspaceFolder: vscode.WorkspaceFolder,
): SidebarExamEntry[] {
  const examsRoot = path.join(workspaceFolder.uri.fsPath, "exams");
  try {
    const entries = fs.readdirSync(examsRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .flatMap((entry): SidebarExamEntry[] => {
        const examName = entry.name;
        const filePath = path.join(examsRoot, examName, "index.mdx");
        if (!fs.existsSync(filePath)) {
          return [];
        }

        try {
          const source = fs.readFileSync(filePath, "utf8");
          const frontmatter = parseExamFrontmatter(source);
          const examNameMetadata = parseExamNameMetadata(examName);
          if (!examNameMetadata) {
            return [];
          }

          const timeMetadata =
            parseExamTimeMetadata(frontmatter.time) || examNameMetadata;

          return [
            {
              examName,
              filePath,
              subject: frontmatter.subject || examNameMetadata.subject,
              type: frontmatter.type || "",
              stage: frontmatter.stage || examNameMetadata.stage,
              term: timeMetadata.term,
              startYear: timeMetadata.startYear,
              endYear: timeMetadata.endYear,
              academicYear: `${timeMetadata.startYear}-${timeMetadata.endYear}`,
              colleges: frontmatter.colleges,
              answerCompleteness: frontmatter.answerCompleteness || "",
              source: frontmatter.source || "",
              remark: examNameMetadata.remark,
            },
          ];
        } catch {
          return [];
        }
      })
      .sort(compareSidebarExamEntries);
  } catch {
    return [];
  }
}

export function compareSidebarExamEntries(
  left: SidebarExamEntry,
  right: SidebarExamEntry,
): number {
  if (left.startYear !== right.startYear) {
    return right.startYear - left.startYear;
  }

  if (left.term !== right.term) {
    return right.term.localeCompare(left.term, "zh-Hans-CN");
  }

  if (left.stage !== right.stage) {
    return left.stage.localeCompare(right.stage, "zh-Hans-CN");
  }

  return left.examName.localeCompare(right.examName, "zh-Hans-CN");
}

export function extractFrontmatterBlock(source: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source);
  return match?.[1] || "";
}

export function parseExamFrontmatter(source: string): {
  readonly time: string;
  readonly subject: string;
  readonly stage: string;
  readonly type: string;
  readonly colleges: readonly string[];
  readonly source: string;
  readonly answerCompleteness: string;
} {
  const frontmatter = extractFrontmatterBlock(source);
  const colleges: string[] = [];
  let currentKey = "";
  const values = {
    time: "",
    subject: "",
    stage: "",
    type: "",
    source: "",
    answerCompleteness: "",
  };

  for (const line of frontmatter.split(/\r?\n/u)) {
    const keyMatch = /^([^:\s][^:]*):\s*(.*)$/u.exec(line);
    if (keyMatch) {
      currentKey = keyMatch[1] || "";
      const value = (keyMatch[2] || "").trim();
      if (currentKey === "时间") values.time = value;
      if (currentKey === "科目") values.subject = value;
      if (currentKey === "阶段") values.stage = value;
      if (currentKey === "类型") values.type = value;
      if (currentKey === "来源") values.source = value;
      if (currentKey === "答案完成度") values.answerCompleteness = value;
      continue;
    }

    if (currentKey === "学院") {
      const collegeMatch = /^\s*-\s+(.+)$/u.exec(line);
      if (collegeMatch?.[1]) {
        colleges.push(collegeMatch[1].trim());
      }
    }
  }

  return {
    ...values,
    colleges,
  };
}

export function parseExamNameMetadata(examName: string): {
  readonly startYear: number;
  readonly endYear: number;
  readonly term: TermValue;
  readonly subject: string;
  readonly stage: string;
  readonly remark: string;
} | null {
  const match = EXAM_NAME_PATTERN.exec(examName);
  if (!match) {
    return null;
  }

  const shortStartYear = Number.parseInt(match[1] || "", 10);
  const shortEndYear = Number.parseInt(match[2] || "", 10);
  const term = match[3] as TermValue | undefined;
  const subject = match[4] || "";
  const stage = match[5] || "";
  const remark = match[6] || "";
  if (
    !Number.isInteger(shortStartYear) ||
    !Number.isInteger(shortEndYear) ||
    (term !== "1" && term !== "2")
  ) {
    return null;
  }

  return {
    startYear: 2000 + shortStartYear,
    endYear: 2000 + shortEndYear,
    term,
    subject,
    stage,
    remark,
  };
}

export function parseExamTimeMetadata(time: string): {
  readonly startYear: number;
  readonly endYear: number;
  readonly term: TermValue;
} | null {
  const match = EXAM_TIME_PATTERN.exec(time);
  if (!match) {
    return null;
  }

  const startYear = Number.parseInt(match[1] || "", 10);
  const endYear = Number.parseInt(match[2] || "", 10);
  const term = match[3] === "一" ? "1" : "2";
  if (!Number.isInteger(startYear) || !Number.isInteger(endYear)) {
    return null;
  }

  return {
    startYear,
    endYear,
    term,
  };
}

export async function openExamPageFromList(
  examName: string,
  previewManagerInstance: ExamPreviewManager,
): Promise<void> {
  const workspaceFolder = getWikiWorkspaceFolderForUri();
  if (!workspaceFolder) {
    return;
  }

  const filePath = path.join(
    workspaceFolder.uri.fsPath,
    "exams",
    examName,
    "index.mdx",
  );
  if (!fs.existsSync(filePath)) {
    void vscode.window.showWarningMessage(`找不到页面：${examName}`);
    return;
  }

  const fileUri = vscode.Uri.file(filePath);
  await previewManagerInstance.showSourceDocument(fileUri, {
    preserveFocus: true,
  });
  await previewManagerInstance.preview(fileUri, {
    focusPreview: true,
  });
}
