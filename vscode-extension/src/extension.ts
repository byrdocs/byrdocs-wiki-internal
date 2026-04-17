/* eslint-disable @typescript-eslint/no-unused-vars */
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  ANSWER_COMPLETENESS_VALUES,
  COMPONENTS,
  CONTENT_CONFIG_PATH,
  DEFAULT_TEMPLATE_PATH,
  MARKER_DOCS,
  STAGE_VALUES,
  TERM_LABELS,
  TERM_VALUES,
  TYPE_VALUES,
  isComponentName,
  type AnswerCompletenessValue,
  type ComponentName,
  type ComponentPropMetadata,
  type ExamTypeValue,
  type StageValue,
  type TermValue,
} from "./lib/metadata";
import {
  findAttributeAtOffset,
  findChoiceMarkerAtOffset,
  findTagAtOffset,
  findTagNameAtOffset,
  getEnclosingChoicesBlock,
  getOpenComponentStack,
  isOffsetIgnored,
  parseDocumentSyntax,
  type ParsedDocumentSyntax,
  type ParsedTag,
} from "./lib/parser";

const SHELL_INTEGRATION_WAIT_MS = 1_000;
const SERVER_DETECTION_TIMEOUT_MS = 90_000;
const SERVER_PING_INTERVAL_MS = 1_500;
const UNRESOLVED_SERVER_ORIGIN_LABEL = "等待终端输出解析";
const CREATE_EXAM_PAGE_CONTAINER_ID = "byrdocsWiki";
const PREVIEW_TERMINAL_NAME = "BYR Docs Wiki Preview";
const CREATE_EXAM_PAGE_VIEW_ID = "byrdocsWiki.createExamPageView";
const SUPPORTED_EXTENSIONS = new Set([".astro", ".mdx"]);
const DEFAULT_EXAM_TEMPLATE = `---
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

const DOCUMENT_SELECTOR: readonly vscode.DocumentFilter[] = [
  { scheme: "file", pattern: "**/*.mdx" },
  { scheme: "file", pattern: "**/*.astro" },
  { scheme: "untitled", language: "markdown" },
  { scheme: "untitled", language: "mdx" },
  { scheme: "untitled", language: "astro" },
];

const SEMANTIC_LEGEND = new vscode.SemanticTokensLegend(
  ["class", "property", "operator", "keyword"],
  [],
);

const documentStateCache = new Map<string, DocumentCacheEntry>();

let previewManager: ExamPreviewManager;
let createExamPageViewProvider: CreateExamPageViewProvider;
let figureDiagnosticCollection: vscode.DiagnosticCollection;

type PreviewStatus = "ready" | "starting" | "timeout";

interface DocumentCacheEntry {
  readonly version: number;
  readonly state: ParsedDocumentSyntax;
}

interface MarkerToggleTarget {
  readonly kind: "marker";
  readonly uri: vscode.Uri;
  readonly line: number;
}

interface OptionTagToggleTarget {
  readonly kind: "optionTag";
  readonly uri: vscode.Uri;
  readonly line: number;
  readonly character: number;
}

type ToggleTarget = MarkerToggleTarget | OptionTagToggleTarget;
type ToggleTargetPayload =
  | Omit<MarkerToggleTarget, "uri">
  | Omit<OptionTagToggleTarget, "uri">;

interface OpeningTagCompletionContext {
  readonly kind: "openingTag";
  readonly prefix: string;
  readonly replaceStart: number;
}

interface ClosingTagCompletionContext {
  readonly kind: "closingTag";
  readonly prefix: string;
  readonly replaceStart: number;
}

interface AttributeNameCompletionContext {
  readonly kind: "attributeName";
  readonly componentName: ComponentName;
  readonly prefix: string;
  readonly replaceStart: number;
  readonly existingAttributes: readonly string[];
}

interface AttributeValueCompletionContext {
  readonly kind: "attributeValue";
  readonly componentName: ComponentName;
  readonly attributeName: string;
  readonly prefix: string;
  readonly replaceStart: number;
}

type CompletionContext =
  | OpeningTagCompletionContext
  | ClosingTagCompletionContext
  | AttributeNameCompletionContext
  | AttributeValueCompletionContext;

interface ExamPreviewTarget {
  readonly workspaceFolder: vscode.WorkspaceFolder;
  readonly examName: string;
  readonly routePath: string;
  readonly fileUri: vscode.Uri;
}

interface CreateExamPageNormalizedPayload {
  readonly source: string;
  readonly subject: string;
  readonly type: ExamTypeValue;
  readonly remark: string;
  readonly phase: StageValue;
  readonly time: string;
  readonly colleges: readonly string[];
  readonly examName: string;
  readonly answerCompleteness: AnswerCompletenessValue | "";
}

interface CreateExamPageResult {
  readonly examName: string;
  readonly fileUri: vscode.Uri;
}

interface CreateExamPageDefaults {
  readonly startYear: number;
  readonly endYear: number;
  readonly term: TermValue;
  readonly stage: StageValue;
  readonly type: ExamTypeValue;
  readonly subject: string;
  readonly remark: string;
  readonly source: string;
  readonly answerCompleteness: AnswerCompletenessValue | "";
}

interface CreateExamPageViewState {
  readonly schools: readonly string[];
  readonly defaults: CreateExamPageDefaults;
}

interface PreviewPanelState {
  readonly examName: string;
  readonly previewUrl: string;
  readonly routePath: string;
  readonly serverOrigin: string;
  readonly status: PreviewStatus;
  readonly statusDetail: string;
  readonly terminalName: string;
}

interface RelativePathCompletionEntry {
  readonly value: string;
  readonly kind: vscode.CompletionItemKind;
}

interface PreviewPanelMessage {
  readonly type: "reload" | "openExternal";
}

interface CreateExamPageRequestMessage {
  readonly type: "createExamPage";
  readonly payload: unknown;
}

type CreateExamPageWebviewMessage = CreateExamPageRequestMessage;

interface CreateExamPageSuccessMessage {
  readonly type: "created";
  readonly examName: string;
  readonly filePath: string;
}

interface CreateExamPageErrorMessage {
  readonly type: "createError";
  readonly message: string;
}

export function activate(context: vscode.ExtensionContext): void {
  previewManager = new ExamPreviewManager();
  createExamPageViewProvider = new CreateExamPageViewProvider(previewManager);
  figureDiagnosticCollection =
    vscode.languages.createDiagnosticCollection("byrdocsWikiFigure");
  const examFileWatcher = vscode.workspace.createFileSystemWatcher("exams/**");

  context.subscriptions.push(
    figureDiagnosticCollection,
    examFileWatcher,
    vscode.commands.registerCommand(
      "byrdocsWiki.previewExamPage",
      async (resource: unknown) => {
        await refreshEnabledContext();
        if (!ensureEnabledWorkspace()) {
          return;
        }

        const targetUri = getCommandTargetUri(resource);
        await previewManager.preview(targetUri);
      },
    ),
    vscode.commands.registerCommand(
      "byrdocsWiki.showCreateExamPage",
      async () => {
        await refreshEnabledContext();
        if (!ensureEnabledWorkspace()) {
          return;
        }

        await createExamPageViewProvider.reveal();
      },
    ),
    vscode.commands.registerCommand(
      "byrdocsWiki.toggleChoiceCorrectness",
      async (target: unknown) => {
        await toggleChoiceCorrectness(target);
      },
    ),
    vscode.window.registerWebviewViewProvider(
      CREATE_EXAM_PAGE_VIEW_ID,
      createExamPageViewProvider,
    ),
    vscode.languages.registerCompletionItemProvider(
      DOCUMENT_SELECTOR,
      createCompletionProvider(),
      "<",
      "/",
      " ",
      '"',
      "'",
    ),
    vscode.languages.registerHoverProvider(
      DOCUMENT_SELECTOR,
      createHoverProvider(),
    ),
    vscode.languages.registerDefinitionProvider(
      DOCUMENT_SELECTOR,
      createDefinitionProvider(),
    ),
    vscode.languages.registerFoldingRangeProvider(
      DOCUMENT_SELECTOR,
      createFoldingRangeProvider(),
    ),
    vscode.languages.registerInlayHintsProvider(
      DOCUMENT_SELECTOR,
      createInlayHintsProvider(),
    ),
    vscode.languages.registerDocumentSemanticTokensProvider(
      DOCUMENT_SELECTOR,
      createSemanticTokensProvider(),
      SEMANTIC_LEGEND,
    ),
    vscode.workspace.onDidChangeTextDocument((event) => {
      clearDocumentState(event.document.uri);
      updateFigureDiagnostics(event.document);
    }),
    vscode.workspace.onDidOpenTextDocument((document) => {
      updateFigureDiagnostics(document);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      clearDocumentState(document.uri);
      figureDiagnosticCollection.delete(document.uri);
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      clearDocumentState(document.uri);
      updateFigureDiagnostics(document);
      if (path.basename(document.fileName) === "package.json") {
        void refreshEnabledContext();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void refreshEnabledContext();
      createExamPageViewProvider.refresh();
      refreshAllOpenFigureDiagnostics();
    }),
    examFileWatcher.onDidCreate(() => {
      refreshAllOpenFigureDiagnostics();
    }),
    examFileWatcher.onDidDelete(() => {
      refreshAllOpenFigureDiagnostics();
    }),
    examFileWatcher.onDidChange(() => {
      refreshAllOpenFigureDiagnostics();
    }),
  );

  void refreshEnabledContext();
  refreshAllOpenFigureDiagnostics();
}

export function deactivate(): void {}

function createCompletionProvider(): vscode.CompletionItemProvider {
  return {
    provideCompletionItems(document, position) {
      if (!isSupportedDocument(document)) {
        return [];
      }

      const documentState = getDocumentState(document);
      const offset = document.offsetAt(position);
      if (isOffsetIgnored(offset, documentState.ignoredRanges)) {
        return [];
      }

      const completionContext = getCompletionContext(document, position);
      if (!completionContext) {
        return [];
      }

      switch (completionContext.kind) {
        case "closingTag":
          return buildClosingTagCompletionItems(
            document,
            position,
            documentState,
            completionContext,
          );
        case "openingTag":
          return buildOpeningTagCompletionItems(
            document,
            position,
            documentState,
            completionContext,
          );
        case "attributeName":
          return buildAttributeNameCompletionItems(
            document,
            position,
            completionContext,
          );
        case "attributeValue":
          return buildAttributeValueCompletionItems(
            document,
            position,
            completionContext,
          );
      }
    },
  };
}

function createHoverProvider(): vscode.HoverProvider {
  return {
    provideHover(document, position) {
      if (!isSupportedDocument(document)) {
        return null;
      }

      const documentState = getDocumentState(document);
      const offset = document.offsetAt(position);
      if (isOffsetIgnored(offset, documentState.ignoredRanges)) {
        return null;
      }

      const componentTag = findTagNameAtOffset(documentState.tags, offset);
      if (componentTag) {
        return new vscode.Hover(
          buildComponentHoverMarkdown(document, componentTag.name),
          buildRange(document, componentTag.nameStart, componentTag.nameEnd),
        );
      }

      const tag = findTagAtOffset(documentState.tags, offset);
      const attribute = findAttributeAtOffset(tag, offset);
      if (attribute && tag) {
        return new vscode.Hover(
          buildAttributeHoverMarkdown(tag.name, attribute.name),
          buildRange(document, attribute.start, attribute.end),
        );
      }

      const marker = findChoiceMarkerAtOffset(documentState.choiceMarkers, offset);
      if (marker) {
        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(
          `${MARKER_DOCS[marker.marker] || "选择题选项语法。"}\n\n`,
        );
        markdown.appendMarkdown("点击行尾的 inlay hint 可直接切换正误。");
        return new vscode.Hover(
          markdown,
          buildRange(document, marker.start, marker.end),
        );
      }

      return null;
    },
  };
}

function createDefinitionProvider(): vscode.DefinitionProvider {
  return {
    provideDefinition(document, position) {
      if (!isSupportedDocument(document)) {
        return null;
      }

      const documentState = getDocumentState(document);
      const offset = document.offsetAt(position);
      const componentTag = findTagNameAtOffset(documentState.tags, offset);
      if (!componentTag) {
        return null;
      }

      const workspaceFolder = getWikiWorkspaceFolderForUri(document.uri);
      if (!workspaceFolder) {
        return null;
      }

      const component = COMPONENTS[componentTag.name];
      const targetPath = path.join(workspaceFolder.uri.fsPath, component.file);
      if (!fs.existsSync(targetPath)) {
        return null;
      }

      return new vscode.Location(
        vscode.Uri.file(targetPath),
        new vscode.Position(0, 0),
      );
    },
  };
}

function createFoldingRangeProvider(): vscode.FoldingRangeProvider {
  return {
    provideFoldingRanges(document) {
      if (!isSupportedDocument(document)) {
        return [];
      }

      const ranges: vscode.FoldingRange[] = [];
      const frontmatterMatch = document
        .getText()
        .match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
      if (frontmatterMatch) {
        const endLine = document.positionAt(frontmatterMatch[0].length).line;
        if (endLine > 0) {
          ranges.push(
            new vscode.FoldingRange(
              0,
              Math.max(0, endLine - 1),
              vscode.FoldingRangeKind.Region,
            ),
          );
        }
      }

      const documentState = getDocumentState(document);
      for (const pair of documentState.pairs) {
        const startLine = document.positionAt(pair.open.start).line;
        const endLine = document.positionAt(pair.close.end).line;
        if (endLine > startLine) {
          ranges.push(
            new vscode.FoldingRange(
              startLine,
              endLine,
              vscode.FoldingRangeKind.Region,
            ),
          );
        }
      }

      return ranges;
    },
  };
}

function createInlayHintsProvider(): vscode.InlayHintsProvider {
  return {
    provideInlayHints(document, visibleRange) {
      if (!isSupportedDocument(document)) {
        return [];
      }

      const documentState = getDocumentState(document);
      const hints: vscode.InlayHint[] = [];

      for (const marker of documentState.choiceMarkers) {
        const choicesBlock = getEnclosingChoicesBlock(
          documentState.pairs,
          marker.start,
        );
        const hasExplicitAnswers =
          choicesBlock !== null &&
          hasExplicitAnswersInChoicesBlock(documentState, choicesBlock);
        if (marker.marker === "-" && !hasExplicitAnswers) {
          continue;
        }

        const position = getChoiceMarkerHintPosition(document, marker);
        if (!positionIntersectsRange(position, visibleRange)) {
          continue;
        }

        hints.push(
          createToggleInlayHint(
            document.uri,
            position,
            {
              kind: "marker",
              line: document.positionAt(marker.start).line,
            },
            marker.marker === "+" ? "正确答案" : "错误答案",
            {
              paddingRight: true,
            },
          ),
        );
      }

      for (const tag of documentState.tags) {
        if (tag.isClosing || tag.name !== "Option") {
          continue;
        }

        const choicesBlock = getEnclosingChoicesBlock(
          documentState.pairs,
          tag.start,
        );
        if (!choicesBlock) {
          continue;
        }

        const isCorrect = tag.attributes.some(
          (attribute) => attribute.name === "correct",
        );
        if (
          !isCorrect &&
          !hasExplicitAnswersInChoicesBlock(documentState, choicesBlock)
        ) {
          continue;
        }

        const position = document.positionAt(tag.end);
        if (!positionIntersectsRange(position, visibleRange)) {
          continue;
        }

        const label = isCorrect ? "正确答案" : "错误答案";

        hints.push(
          createToggleInlayHint(
            document.uri,
            position,
            {
              kind: "optionTag",
              line: document.positionAt(tag.start).line,
              character: document.positionAt(tag.nameStart).character,
            },
            label,
            {
              paddingLeft: true,
              paddingRight: true,
            },
          ),
        );
      }

      return hints;
    },
  };
}

function createSemanticTokensProvider(): vscode.DocumentSemanticTokensProvider {
  return {
    provideDocumentSemanticTokens(document) {
      const builder = new vscode.SemanticTokensBuilder(SEMANTIC_LEGEND);
      if (!isSupportedDocument(document)) {
        return builder.build();
      }

      const documentState = getDocumentState(document);
      for (const tag of documentState.tags) {
        builder.push(buildRange(document, tag.nameStart, tag.nameEnd), "class");

        for (const attribute of tag.attributes) {
          builder.push(
            buildRange(document, attribute.start, attribute.end),
            isBooleanAttribute(tag.name, attribute.name) ? "keyword" : "property",
          );
        }
      }

      for (const marker of documentState.choiceMarkers) {
        builder.push(buildRange(document, marker.start, marker.end), "operator");
      }

      return builder.build();
    },
  };
}

async function toggleChoiceCorrectness(rawTarget: unknown): Promise<void> {
  const target = normalizeToggleTarget(rawTarget);
  if (!target) {
    return;
  }

  const document = await vscode.workspace.openTextDocument(target.uri);
  if (!isSupportedDocument(document)) {
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  if (target.kind === "marker") {
    const line = document.lineAt(target.line);
    const match = /^(\s*)([+-])(?=\s+)/.exec(line.text);
    if (!match) {
      return;
    }

    const markerStart = match[1]?.length ?? 0;
    const nextMarker = match[2] === "+" ? "-" : "+";
    edit.replace(
      document.uri,
      new vscode.Range(
        new vscode.Position(target.line, markerStart),
        new vscode.Position(target.line, markerStart + 1),
      ),
      nextMarker,
    );
  } else {
    const documentState = getDocumentState(document);
    const tag = documentState.tags.find((candidate) => {
      return (
        !candidate.isClosing &&
        candidate.name === "Option" &&
        document.positionAt(candidate.nameStart).line === target.line &&
        document.positionAt(candidate.nameStart).character === target.character
      );
    });

    if (!tag) {
      return;
    }

    const correctAttribute = tag.attributes.find(
      (attribute) => attribute.name === "correct",
    );
    if (correctAttribute) {
      const source = document.getText();
      let removeStart = correctAttribute.start;
      while (
        removeStart > tag.nameEnd &&
        /\s/.test(source.charAt(removeStart - 1))
      ) {
        removeStart -= 1;
      }

      edit.delete(
        document.uri,
        buildRange(document, removeStart, correctAttribute.end),
      );
    } else {
      const insertOffset = tag.end - (tag.selfClosing ? 2 : 1);
      edit.insert(document.uri, document.positionAt(insertOffset), " correct");
    }
  }

  await vscode.workspace.applyEdit(edit);
  clearDocumentState(document.uri);
}

class ExamPreviewManager {
  private currentExam: ExamPreviewTarget | null = null;
  private localServerBaseUri: vscode.Uri | null = null;
  private externalBaseUri: vscode.Uri | null = null;
  private panel: vscode.WebviewPanel | null = null;
  private serverReady = false;
  private statusDetail = "";
  private terminal: vscode.Terminal | null = null;
  private serverOriginParsePromise: Promise<vscode.Uri | null> | null = null;
  private waitForServerPromise: Promise<boolean> | null = null;

  async preview(resourceUri: vscode.Uri | null): Promise<void> {
    const targetUri = resourceUri || getCommandTargetUri(undefined);
    if (!targetUri) {
      void vscode.window.showWarningMessage(
        "请先打开一个 `exams/<name>/index.mdx` 文件。",
      );
      return;
    }

    const examTarget = getExamPreviewTarget(targetUri);
    if (!examTarget) {
      void vscode.window.showWarningMessage(
        "只支持预览 `exams/<name>/index.mdx` 文件。",
      );
      return;
    }

    this.currentExam = examTarget;
    const panel = this.ensurePanel();
    panel.title = `预览: ${examTarget.examName}`;
    this.statusDetail = "启动终端";
    await this.updatePanel("starting");

    await this.ensureServer();
    const ready = await this.waitForServer();
    if (!this.panel || !this.currentExam) {
      return;
    }

    await this.updatePanel(ready ? "ready" : "timeout");
  }

  private ensurePanel(): vscode.WebviewPanel {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      return this.panel;
    }

    this.panel = vscode.window.createWebviewPanel(
      "byrdocsWiki.preview",
      "BYR Docs Wiki Preview",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    this.panel.onDidDispose(() => {
      this.panel = null;
    });

    this.panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!isPreviewPanelMessage(message)) {
        return;
      }

      if (message.type === "reload") {
        if (!this.currentExam) {
          return;
        }

        await this.updatePanel(this.serverReady ? "ready" : "starting");
        return;
      }

      const previewUri = await this.getExternalPreviewUri();
      if (previewUri) {
        await vscode.env.openExternal(previewUri);
      }
    });

    return this.panel;
  }

  private async ensureServer(): Promise<void> {
    if (this.localServerBaseUri && (await pingServer(this.localServerBaseUri))) {
      this.serverReady = true;
      this.statusDetail = "连接预览";
      if (!this.externalBaseUri) {
        this.externalBaseUri = await vscode.env.asExternalUri(
          this.localServerBaseUri,
        );
      }
      return;
    }

    if (this.terminal && !this.terminal.exitStatus) {
      return;
    }

    const workspaceFolder =
      this.currentExam?.workspaceFolder || getWikiWorkspaceFolderForUri();
    if (!workspaceFolder) {
      return;
    }

    this.serverReady = false;
    this.statusDetail = "";
    this.localServerBaseUri = null;
    this.externalBaseUri = null;
    this.serverOriginParsePromise = null;
    this.statusDetail = "启动终端";
    this.terminal = vscode.window.createTerminal({
      name: PREVIEW_TERMINAL_NAME,
      cwd: workspaceFolder.uri.fsPath,
    });
    await this.updatePanel("starting");

    this.statusDetail = "等待终端就绪";
    await this.updatePanel("starting");
    const shellIntegration = await waitForTerminalShellIntegration(
      this.terminal,
      SHELL_INTEGRATION_WAIT_MS,
    );

    if (!shellIntegration) {
      this.statusDetail = "终端未就绪";
      this.terminal.sendText("pnpm i && pnpm dev");
      this.terminal.show(true);
      this.serverOriginParsePromise = Promise.resolve(null);
      await this.updatePanel("starting");
      return;
    }

    this.statusDetail = "启动开发服务器";
    await this.updatePanel("starting");
    const execution = shellIntegration.executeCommand("pnpm i && pnpm dev");
    this.terminal.show(true);
    this.serverOriginParsePromise = this.captureServerOriginFromExecution(
      execution,
    );
  }

  private async waitForServer(): Promise<boolean> {
    if (
      this.serverReady &&
      this.localServerBaseUri &&
      (await pingServer(this.localServerBaseUri))
    ) {
      if (!this.externalBaseUri) {
        this.externalBaseUri = await vscode.env.asExternalUri(
          this.localServerBaseUri,
        );
      }
      return true;
    }

    if (this.waitForServerPromise) {
      return this.waitForServerPromise;
    }

    this.waitForServerPromise = (async () => {
      const parsedServerBaseUri = await this.serverOriginParsePromise;
      if (!parsedServerBaseUri) {
        this.serverReady = false;
        this.statusDetail = "无法解析开发服务器地址";
        return false;
      }

      this.statusDetail = "等待开发服务器响应";
      await this.updatePanel("starting");
      const ready = await waitForServerUri(
        parsedServerBaseUri,
        SERVER_DETECTION_TIMEOUT_MS,
        SERVER_PING_INTERVAL_MS,
      );
      this.serverReady = ready;
      if (ready) {
        this.statusDetail = "加载预览";
        this.externalBaseUri = await vscode.env.asExternalUri(
          parsedServerBaseUri,
        );
      } else {
        this.statusDetail = "预览连接超时";
      }
      return ready;
    })().finally(() => {
      this.waitForServerPromise = null;
    });

    return this.waitForServerPromise;
  }

  private async getExternalPreviewUri(): Promise<vscode.Uri | null> {
    if (!this.currentExam) {
      return null;
    }

    if (!this.externalBaseUri && this.localServerBaseUri) {
      this.externalBaseUri = await vscode.env.asExternalUri(
        this.localServerBaseUri,
      );
    }

    if (!this.externalBaseUri) {
      return null;
    }

    return appendPathToUri(this.externalBaseUri, this.currentExam.routePath);
  }

  private async updatePanel(status: PreviewStatus): Promise<void> {
    if (!this.panel || !this.currentExam) {
      return;
    }

    const previewUri =
      status === "ready" ? await this.getExternalPreviewUri() : null;
    this.panel.webview.html = renderPreviewPanelHtml(this.panel.webview, {
      examName: this.currentExam.examName,
      previewUrl: previewUri?.toString() || "",
      routePath: this.currentExam.routePath,
      serverOrigin:
        this.localServerBaseUri?.toString() || UNRESOLVED_SERVER_ORIGIN_LABEL,
      status,
      statusDetail: this.statusDetail,
      terminalName: PREVIEW_TERMINAL_NAME,
    });
  }

  private async captureServerOriginFromExecution(
    execution: vscode.TerminalShellExecution,
  ): Promise<vscode.Uri | null> {
    return new Promise((resolve) => {
      let settled = false;
      const endExecutionDisposable = vscode.window.onDidEndTerminalShellExecution(
        (event) => {
          if (event.execution !== execution) {
            return;
          }

          cleanup();
          settle(this.localServerBaseUri);
        },
      );
      let timeoutHandle: NodeJS.Timeout | null = setTimeout(() => {
        timeoutHandle = null;
        settle(null);
      }, SERVER_DETECTION_TIMEOUT_MS);

      const cleanup = (): void => {
        endExecutionDisposable.dispose();
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
      };

      const settle = (value: vscode.Uri | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      };

      void (async () => {
        let outputBuffer = "";
        try {
          for await (const chunk of execution.read()) {
            outputBuffer = `${outputBuffer}${chunk}`.slice(-32_768);
            const parsedServerBaseUri =
              parseServerBaseUriFromTerminalOutput(outputBuffer);
            if (!parsedServerBaseUri) {
              continue;
            }

            this.localServerBaseUri = parsedServerBaseUri;
            this.externalBaseUri = await vscode.env.asExternalUri(
              parsedServerBaseUri,
            );
            this.statusDetail = "等待开发服务器响应";
            await this.updatePanel("starting");
            settle(parsedServerBaseUri);
            return;
          }
        } catch {}

        settle(null);
      })();
    });
  }
}

class CreateExamPageViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;

  constructor(private readonly previewManagerInstance: ExamPreviewManager) {}

  refresh(): void {
    if (!this.view) {
      return;
    }

    this.view.webview.html = this.render(this.view.webview);
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand(
      `workbench.view.extension.${CREATE_EXAM_PAGE_CONTAINER_ID}`,
    );
    if (this.view) {
      this.view.show?.(true);
      return;
    }

    try {
      await vscode.commands.executeCommand(`${CREATE_EXAM_PAGE_VIEW_ID}.focus`);
    } catch {}
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.render(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!isCreateExamPageWebviewMessage(message)) {
        return;
      }

      try {
        const result = await createExamPageFromPayload(
          message.payload,
          this.previewManagerInstance,
        );
        const success: CreateExamPageSuccessMessage = {
          type: "created",
          examName: result.examName,
          filePath: result.fileUri.fsPath,
        };
        void webviewView.webview.postMessage(success);
      } catch (error) {
        const messageText =
          error instanceof Error ? error.message : String(error);
        const failure: CreateExamPageErrorMessage = {
          type: "createError",
          message: messageText,
        };
        void webviewView.webview.postMessage(failure);
      }
    });

    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = null;
      }
    });
  }

  private render(webview: vscode.Webview): string {
    const workspaceFolder = getWikiWorkspaceFolderForUri();
    const schools = workspaceFolder ? readSchoolOptions(workspaceFolder) : [];
    const defaults = getDefaultCreateFormState();

    return renderCreateExamPageViewHtml(webview, {
      schools,
      defaults,
    });
  }
}

async function createExamPageFromPayload(
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
    );
    const fileUri = vscode.Uri.file(filePath);
    if (choice === "打开现有页面") {
      const document = await vscode.workspace.openTextDocument(fileUri);
      await vscode.window.showTextDocument(document, { preview: false });
      await previewManagerInstance.preview(fileUri);
    }

    return {
      examName: payload.examName,
      fileUri,
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
  const document = await vscode.workspace.openTextDocument(fileUri);
  await vscode.window.showTextDocument(document, { preview: false });
  await previewManagerInstance.preview(fileUri);

  return {
    examName: payload.examName,
    fileUri,
  };
}

function normalizeCreateExamPayload(
  rawPayload: unknown,
  schoolOptions: readonly string[],
): CreateExamPageNormalizedPayload {
  const payload = asRecord(rawPayload);
  const startYear = Number.parseInt(toStringValue(payload.startYear), 10);
  const endYear = Number.parseInt(toStringValue(payload.endYear), 10);
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

  if (!Number.isInteger(endYear) || String(endYear).length !== 4) {
    throw new Error("结束年份必须是四位数字。");
  }

  if (endYear !== startYear + 1) {
    throw new Error("结束年份必须恰好等于开始年份 + 1。");
  }

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

async function readExamTemplate(
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

function renderExamTemplate(
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

function buildClosingTagCompletionItems(
  document: vscode.TextDocument,
  position: vscode.Position,
  documentState: ParsedDocumentSyntax,
  completionContext: ClosingTagCompletionContext,
): vscode.CompletionItem[] {
  const offset = document.offsetAt(position);
  const openStack = getOpenComponentStack(documentState.tags, offset);
  const uniqueNames: ComponentName[] = [];

  for (let index = openStack.length - 1; index >= 0; index -= 1) {
    const name = openStack[index]?.name;
    if (name && !uniqueNames.includes(name)) {
      uniqueNames.push(name);
    }
  }

  const replaceRange = buildTagCompletionReplaceRange(
    document,
    completionContext.replaceStart,
    position,
  );

  return uniqueNames
    .filter((name) =>
      name.toLowerCase().startsWith(completionContext.prefix.toLowerCase()),
    )
    .map((name, index) => {
      const item = new vscode.CompletionItem(
        `</${name}>`,
        vscode.CompletionItemKind.Class,
      );
      item.range = replaceRange;
      item.insertText = `${name}>`;
      item.detail = "补全结束标签";
      item.sortText = String(index).padStart(2, "0");
      return item;
    });
}

function buildOpeningTagCompletionItems(
  document: vscode.TextDocument,
  position: vscode.Position,
  documentState: ParsedDocumentSyntax,
  completionContext: OpeningTagCompletionContext,
): vscode.CompletionItem[] {
  const replaceRange = buildTagCompletionReplaceRange(
    document,
    completionContext.replaceStart,
    position,
  );
  const insideChoices = Boolean(
    getEnclosingChoicesBlock(documentState.pairs, document.offsetAt(position)),
  );
  const items: vscode.CompletionItem[] = [];

  for (const [componentName, component] of Object.entries(COMPONENTS) as [
    ComponentName,
    (typeof COMPONENTS)[ComponentName],
  ][]) {
    if (
      completionContext.prefix &&
      !componentName
        .toLowerCase()
        .startsWith(completionContext.prefix.toLowerCase())
    ) {
      continue;
    }

    component.snippets.forEach((snippet, snippetIndex) => {
      const item = new vscode.CompletionItem(
        snippet.label,
        vscode.CompletionItemKind.Class,
      );
      item.range = replaceRange;
      item.insertText = new vscode.SnippetString(snippet.body);
      item.detail = snippet.description;
      item.documentation = buildComponentHoverMarkdown(document, componentName);
      item.sortText = `${insideChoices && componentName === "Option" ? "00" : "10"}-${componentName}-${snippetIndex}`;
      items.push(item);
    });
  }

  return items;
}

function buildAttributeNameCompletionItems(
  document: vscode.TextDocument,
  position: vscode.Position,
  completionContext: AttributeNameCompletionContext,
): vscode.CompletionItem[] {
  const component = COMPONENTS[completionContext.componentName];
  const replaceRange = new vscode.Range(
    document.positionAt(completionContext.replaceStart),
    position,
  );
  const existingAttributes = new Set(completionContext.existingAttributes);
  const items: vscode.CompletionItem[] = [];

  for (const [attributeName, metadata] of Object.entries(component.props)) {
    if (
      completionContext.prefix &&
      !attributeName
        .toLowerCase()
        .startsWith(completionContext.prefix.toLowerCase())
    ) {
      continue;
    }

    if (
      existingAttributes.has(attributeName) &&
      attributeName !== completionContext.prefix
    ) {
      continue;
    }

    const item = new vscode.CompletionItem(
      attributeName,
      vscode.CompletionItemKind.Property,
    );
    item.range = replaceRange;
    item.documentation = buildAttributeHoverMarkdown(
      completionContext.componentName,
      attributeName,
    );
    item.insertText =
      metadata.valueKind === "boolean-attr"
        ? attributeName
        : new vscode.SnippetString(
            `${attributeName}="${metadata.values?.[0] || defaultAttributeValue(attributeName)}"`,
          );
    item.detail = metadata.description;
    items.push(item);
  }

  return items;
}

function buildAttributeValueCompletionItems(
  document: vscode.TextDocument,
  position: vscode.Position,
  completionContext: AttributeValueCompletionContext,
): vscode.CompletionItem[] {
  const component = COMPONENTS[completionContext.componentName];
  const props = component.props as Readonly<
    Record<string, ComponentPropMetadata>
  >;
  const attribute = props[completionContext.attributeName];
  if (!attribute) {
    return [];
  }

  const replaceRange = new vscode.Range(
    document.positionAt(completionContext.replaceStart),
    position,
  );
  const values = new Set<string>();
  const relativePathEntries =
    completionContext.attributeName === "src"
      ? collectRelativePathCompletions(
          document,
          completionContext.componentName,
          completionContext.prefix,
        )
      : [];

  for (const value of attribute.values || []) {
    values.add(value);
  }

  if (completionContext.attributeName === "item") {
    ["1", "2", "3", "4"].forEach((value) => values.add(value));
  }

  if (completionContext.attributeName === "src") {
    for (const entry of relativePathEntries) {
      values.add(entry.value);
    }
  }

  return [...values]
    .filter((value) =>
      value.toLowerCase().startsWith(completionContext.prefix.toLowerCase()),
    )
    .map((value) => {
      const relativeEntry = relativePathEntries.find(
        (entry) => entry.value === value,
      );
      const item = new vscode.CompletionItem(
        value,
        relativeEntry?.kind ||
          (completionContext.attributeName === "src"
            ? vscode.CompletionItemKind.File
            : vscode.CompletionItemKind.Value),
      );
      item.range = replaceRange;
      item.insertText = value;
      item.documentation = buildAttributeHoverMarkdown(
        completionContext.componentName,
        completionContext.attributeName,
      );
      return item;
    });
}

function buildComponentHoverMarkdown(
  document: vscode.TextDocument,
  componentName: ComponentName,
): vscode.MarkdownString {
  const component = COMPONENTS[componentName];
  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**<${componentName}>**\n\n${component.description}`);

  const props = Object.entries(component.props);
  if (props.length > 0) {
    markdown.appendMarkdown("\n\n**属性**\n");
    for (const [attributeName, metadata] of props) {
      const valueInfo = metadata.values?.length
        ? ` 可选值：\`${metadata.values.join("` `")}\`。`
        : "";
      markdown.appendMarkdown(
        `\n- \`${attributeName}\`：${metadata.description}${valueInfo}`,
      );
    }
  }

  const workspaceFolder = getWikiWorkspaceFolderForUri(document.uri);
  if (workspaceFolder) {
    const targetPath = path.join(workspaceFolder.uri.fsPath, component.file);
    markdown.appendMarkdown(
      `\n\n实现文件：\`${path.relative(workspaceFolder.uri.fsPath, targetPath)}\``,
    );
  }

  return markdown;
}

function buildAttributeHoverMarkdown(
  componentName: ComponentName,
  attributeName: string,
): vscode.MarkdownString {
  const props = COMPONENTS[componentName].props as Readonly<
    Record<string, ComponentPropMetadata>
  >;
  const metadata = props[attributeName];
  const markdown = new vscode.MarkdownString();
  if (!metadata) {
    markdown.appendMarkdown(`\`${attributeName}\``);
    return markdown;
  }

  markdown.appendMarkdown(
    `**${componentName}.${attributeName}**\n\n${metadata.description}`,
  );
  if (metadata.values?.length) {
    markdown.appendMarkdown(
      `\n\n可选值：\`${metadata.values.join("` `")}\``,
    );
  }

  return markdown;
}

function buildRange(
  document: vscode.TextDocument,
  startOffset: number,
  endOffset: number,
): vscode.Range {
  return new vscode.Range(
    document.positionAt(startOffset),
    document.positionAt(endOffset),
  );
}

function buildTagCompletionReplaceRange(
  document: vscode.TextDocument,
  replaceStart: number,
  position: vscode.Position,
): vscode.Range {
  const line = document.lineAt(position.line);
  const shouldConsumeAutoClosedAngleBracket =
    position.character < line.text.length &&
    line.text.charAt(position.character) === ">";

  return new vscode.Range(
    document.positionAt(replaceStart),
    shouldConsumeAutoClosedAngleBracket
      ? position.translate(0, 1)
      : position,
  );
}

function collectRelativePathCompletions(
  document: vscode.TextDocument,
  componentName: ComponentName,
  prefix: string,
): RelativePathCompletionEntry[] {
  if (document.uri.scheme !== "file") {
    return [];
  }

  try {
    const documentDirectory = path.dirname(document.uri.fsPath);
    const normalizedPrefix = prefix.replaceAll("\\", "/");
    const hasExplicitCurrentDirectory = normalizedPrefix.startsWith("./");
    const cleanedPrefix = hasExplicitCurrentDirectory
      ? normalizedPrefix.slice(2)
      : normalizedPrefix;
    if (cleanedPrefix.startsWith("../") || cleanedPrefix === "..") {
      return [];
    }

    const slashIndex = cleanedPrefix.lastIndexOf("/");
    const relativeDirectoryPrefix =
      slashIndex >= 0 ? cleanedPrefix.slice(0, slashIndex + 1) : "";
    const completionDirectory = path.resolve(
      documentDirectory,
      relativeDirectoryPrefix || ".",
    );
    if (
      path.relative(documentDirectory, completionDirectory).startsWith("..")
    ) {
      return [];
    }

    const entries = fs.readdirSync(completionDirectory, { withFileTypes: true });
    const extensions =
      componentName === "Audio"
        ? /\.(aac|flac|m4a|mp3|ogg|wav)$/i
        : /\.(avif|gif|jpe?g|png|svg|webp)$/i;
    const prefixBase = hasExplicitCurrentDirectory ? "./" : "";

    return entries
      .flatMap((entry): RelativePathCompletionEntry[] => {
        if (entry.isDirectory()) {
          return [
            {
              value: `${prefixBase}${relativeDirectoryPrefix}${entry.name}/`,
              kind: vscode.CompletionItemKind.Folder,
            },
          ];
        }

        if (
          entry.isFile() &&
          entry.name !== "index.mdx" &&
          extensions.test(entry.name)
        ) {
          return [
            {
              value: `${prefixBase}${relativeDirectoryPrefix}${entry.name}`,
              kind: vscode.CompletionItemKind.File,
            },
          ];
        }

        return [];
      })
      .sort((left, right) =>
        left.value.localeCompare(right.value, "zh-Hans-CN"),
      );
  } catch {
    return [];
  }
}

function getChoiceMarkerHintPosition(
  document: vscode.TextDocument,
  marker: ParsedDocumentSyntax["choiceMarkers"][number],
): vscode.Position {
  const source = document.getText();
  let offset = marker.end;

  while (
    offset < marker.lineEnd &&
    (source.charAt(offset) === " " || source.charAt(offset) === "\t")
  ) {
    offset += 1;
  }

  return document.positionAt(offset);
}

function hasExplicitAnswersInChoicesBlock(
  documentState: ParsedDocumentSyntax,
  choicesBlock: NonNullable<ReturnType<typeof getEnclosingChoicesBlock>>,
): boolean {
  const contentStart = choicesBlock.open.end;
  const contentEnd = choicesBlock.close.start;

  const hasCorrectMarker = documentState.choiceMarkers.some(
    (marker) =>
      marker.marker === "+" &&
      marker.start >= contentStart &&
      marker.start < contentEnd,
  );
  if (hasCorrectMarker) {
    return true;
  }

  return documentState.tags.some(
    (tag) =>
      !tag.isClosing &&
      tag.name === "Option" &&
      tag.start >= contentStart &&
      tag.start < contentEnd &&
      tag.attributes.some((attribute) => attribute.name === "correct"),
  );
}

function createToggleInlayHint(
  uri: vscode.Uri,
  position: vscode.Position,
  target: ToggleTargetPayload,
  label: string,
  spacing: {
    readonly paddingLeft?: boolean;
    readonly paddingRight?: boolean;
  } = {},
): vscode.InlayHint {
  const labelParts: vscode.InlayHintLabelPart[] = [
    {
      value: ` ${label} `,
      tooltip: "单击切换正误状态",
      command: {
        command: "byrdocsWiki.toggleChoiceCorrectness",
        title: "切换选项正误",
        arguments: [{ ...target, uri }],
      },
    },
  ];
  const hint = new vscode.InlayHint(position, labelParts, vscode.InlayHintKind.Type);
  if (spacing.paddingLeft !== undefined) {
    hint.paddingLeft = spacing.paddingLeft;
  }
  if (spacing.paddingRight !== undefined) {
    hint.paddingRight = spacing.paddingRight;
  }
  return hint;
}

function defaultAttributeValue(attributeName: string): string {
  if (attributeName === "src") {
    return "example";
  }

  if (attributeName === "item") {
    return "1";
  }

  return "";
}

function ensureEnabledWorkspace(): boolean {
  if (hasWikiWorkspace()) {
    return true;
  }

  void vscode.window.showWarningMessage(
    "当前工作区未检测到 `package.json` 的 `name: byrdocs-wiki`，扩展功能不会启用。",
  );
  return false;
}

function getCommandTargetUri(resource: unknown): vscode.Uri | null {
  if (resource instanceof vscode.Uri) {
    return resource;
  }

  if (isRecord(resource) && resource.resourceUri instanceof vscode.Uri) {
    return resource.resourceUri;
  }

  return vscode.window.activeTextEditor?.document.uri || null;
}

function getCompletionContext(
  document: vscode.TextDocument,
  position: vscode.Position,
): CompletionContext | null {
  const offset = document.offsetAt(position);
  const contextStart = Math.max(0, offset - 500);
  const beforeCursor = document.getText(
    new vscode.Range(document.positionAt(contextStart), position),
  );
  const lastTagStart = beforeCursor.lastIndexOf("<");
  const lastTagEnd = beforeCursor.lastIndexOf(">");
  if (lastTagStart === -1 || lastTagEnd > lastTagStart) {
    return null;
  }

  const rawTag = beforeCursor.slice(lastTagStart);
  const tagStartOffset = contextStart + lastTagStart;

  const closingMatch = rawTag.match(/^<\/([A-Z][A-Za-z0-9]*)?$/);
  if (closingMatch) {
    return {
      kind: "closingTag",
      prefix: closingMatch[1] || "",
      replaceStart: offset - (closingMatch[1]?.length || 0),
    };
  }

  const openingMatch = rawTag.match(/^<([A-Z][A-Za-z0-9]*)?$/);
  if (openingMatch) {
    return {
      kind: "openingTag",
      prefix: openingMatch[1] || "",
      replaceStart: tagStartOffset + 1,
    };
  }

  const startTagMatch = rawTag.match(/^<([A-Z][A-Za-z0-9]*)([\s\S]*)$/);
  if (!startTagMatch) {
    return null;
  }

  const rawComponentName = startTagMatch[1] || "";
  const afterName = startTagMatch[2] || "";
  if (!isComponentName(rawComponentName)) {
    return {
      kind: "openingTag",
      prefix: rawComponentName,
      replaceStart: tagStartOffset + 1,
    };
  }

  const doubleQuotedValueMatch = afterName.match(
    /([A-Za-z][\w-]*)\s*=\s*"([^"]*)$/,
  );
  const singleQuotedValueMatch = afterName.match(
    /([A-Za-z][\w-]*)\s*=\s*'([^']*)$/,
  );
  const valueMatch = doubleQuotedValueMatch || singleQuotedValueMatch;
  if (valueMatch) {
    return {
      kind: "attributeValue",
      componentName: rawComponentName,
      attributeName: valueMatch[1] || "",
      prefix: valueMatch[2] || "",
      replaceStart: offset - (valueMatch[2]?.length || 0),
    };
  }

  const attributePrefixMatch = afterName.match(/(?:^|\s)([A-Za-z][\w-]*)?$/);
  if (!attributePrefixMatch) {
    return null;
  }

  return {
    kind: "attributeName",
    componentName: rawComponentName,
    prefix: attributePrefixMatch[1] || "",
    replaceStart: offset - (attributePrefixMatch[1]?.length || 0),
    existingAttributes: extractExistingAttributes(afterName),
  };
}

function getDefaultCreateFormState(): CreateExamPageDefaults {
  const now = new Date();
  const month = now.getMonth() + 1;
  const startYear = month >= 8 ? now.getFullYear() : now.getFullYear() - 1;
  return {
    startYear,
    endYear: startYear + 1,
    term: month >= 2 && month <= 7 ? "2" : "1",
    stage: "期末",
    type: "本科",
    subject: "",
    remark: "",
    source: "",
    answerCompleteness: "",
  };
}

function getDocumentExtension(document: vscode.TextDocument): string {
  return path.extname(document.fileName || document.uri.path);
}

function getUriExtension(uri: vscode.Uri): string {
  return path.extname(uri.fsPath || uri.path);
}

function getDocumentState(document: vscode.TextDocument): ParsedDocumentSyntax {
  const cacheKey = document.uri.toString();
  const cached = documentStateCache.get(cacheKey);
  if (cached && cached.version === document.version) {
    return cached.state;
  }

  const state = parseDocumentSyntax(document.getText());
  documentStateCache.set(cacheKey, {
    version: document.version,
    state,
  });
  return state;
}

function refreshAllOpenFigureDiagnostics(): void {
  for (const document of vscode.workspace.textDocuments) {
    updateFigureDiagnostics(document);
  }
}

function updateFigureDiagnostics(document: vscode.TextDocument): void {
  if (document.uri.scheme !== "file" || getUriExtension(document.uri) !== ".mdx") {
    figureDiagnosticCollection.delete(document.uri);
    return;
  }

  const examTarget = getExamPreviewTarget(document.uri);
  if (!examTarget) {
    figureDiagnosticCollection.delete(document.uri);
    return;
  }

  const documentState = getDocumentState(document);
  const diagnostics: vscode.Diagnostic[] = [];

  for (const tag of documentState.tags) {
    if (tag.isClosing || tag.name !== "Figure") {
      continue;
    }

    const srcAttribute = tag.attributes.find((attribute) => attribute.name === "src");
    const srcValue = srcAttribute?.value?.trim();
    if (!srcAttribute || !srcValue || !isRelativeFigureSource(srcValue)) {
      continue;
    }

    const targetPath = path.resolve(path.dirname(document.uri.fsPath), srcValue);
    if (fs.existsSync(targetPath)) {
      continue;
    }

    const diagnostic = new vscode.Diagnostic(
      buildRange(document, srcAttribute.start, srcAttribute.end),
      `Figure src 引用的文件不存在：${srcValue}`,
      vscode.DiagnosticSeverity.Error,
    );
    diagnostic.source = "BYR Docs Wiki";
    diagnostics.push(diagnostic);
  }

  figureDiagnosticCollection.set(document.uri, diagnostics);
}

function getExamPreviewTarget(resourceUri: vscode.Uri): ExamPreviewTarget | null {
  const workspaceFolder = getWikiWorkspaceFolderForUri(resourceUri);
  if (!workspaceFolder || resourceUri.scheme !== "file") {
    return null;
  }

  const relativePath = path.relative(workspaceFolder.uri.fsPath, resourceUri.fsPath);
  const parts = relativePath.split(path.sep);
  if (parts.length !== 3 || parts[0] !== "exams" || parts[2] !== "index.mdx") {
    return null;
  }

  const examName = parts[1];
  if (!examName) {
    return null;
  }

  return {
    workspaceFolder,
    examName,
    routePath: `/exam/${examName}`,
    fileUri: resourceUri,
  };
}

function isRelativeFigureSource(srcValue: string): boolean {
  return (
    !/^(?:[a-z]+:)?\/\//i.test(srcValue) &&
    !srcValue.startsWith("/") &&
    !path.isAbsolute(srcValue)
  );
}

function getUriOrigin(uriString: string): string {
  const url = new URL(uriString);
  return `${url.protocol}//${url.host}`;
}

function getWikiWorkspaceFolderForUri(
  uri?: vscode.Uri,
): vscode.WorkspaceFolder | null {
  if (uri) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (workspaceFolder && isWikiWorkspaceFolder(workspaceFolder)) {
      return workspaceFolder;
    }
  }

  return getWikiWorkspaceFolders()[0] || null;
}

function getWikiWorkspaceFolders(): vscode.WorkspaceFolder[] {
  return (vscode.workspace.workspaceFolders || []).filter((workspaceFolder) =>
    isWikiWorkspaceFolder(workspaceFolder),
  );
}

function hasWikiWorkspace(): boolean {
  return getWikiWorkspaceFolders().length > 0;
}

function isBooleanAttribute(
  componentName: ComponentName,
  attributeName: string,
): boolean {
  const props = COMPONENTS[componentName].props as Readonly<
    Record<string, ComponentPropMetadata>
  >;
  return (
    props[attributeName]?.valueKind === "boolean-attr"
  );
}

function isSupportedDocument(document: vscode.TextDocument): boolean {
  return (
    SUPPORTED_EXTENSIONS.has(getDocumentExtension(document)) &&
    Boolean(getWikiWorkspaceFolderForUri(document.uri))
  );
}

function isWikiWorkspaceFolder(
  workspaceFolder: vscode.WorkspaceFolder,
): boolean {
  if (workspaceFolder.uri.scheme !== "file") {
    return false;
  }

  const packagePath = path.join(workspaceFolder.uri.fsPath, "package.json");
  try {
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
      readonly name?: string;
    };
    return packageJson.name === "byrdocs-wiki";
  } catch {
    return false;
  }
}

function normalizeRemark(remark: string): string {
  return remark
    .trim()
    .replace(/^[（(]\s*/, "")
    .replace(/\s*[）)]$/, "")
    .trim();
}

function normalizeToggleTarget(rawTarget: unknown): ToggleTarget | null {
  const record = asRecord(rawTarget);
  const revivedUri = reviveUri(record.uri);
  if (!revivedUri) {
    return null;
  }

  if (record.kind === "marker" && typeof record.line === "number") {
    return {
      kind: "marker",
      uri: revivedUri,
      line: record.line,
    };
  }

  if (
    record.kind === "optionTag" &&
    typeof record.line === "number" &&
    typeof record.character === "number"
  ) {
    return {
      kind: "optionTag",
      uri: revivedUri,
      line: record.line,
      character: record.character,
    };
  }

  return null;
}

function padAcademicYear(year: number): string {
  return String(year).slice(-2).padStart(2, "0");
}

function positionIntersectsRange(
  position: vscode.Position,
  range: vscode.Range,
): boolean {
  return (
    position.isAfterOrEqual(range.start) && position.isBeforeOrEqual(range.end)
  );
}

async function pingServer(baseUri: vscode.Uri): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get(
      baseUri.toString(),
      { timeout: 1500 },
      (response) => {
        response.resume();
        resolve(true);
      },
    );

    request.on("error", () => resolve(false));
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
  });
}

function parseServerBaseUriFromTerminalOutput(
  output: string,
): vscode.Uri | null {
  const cleanedOutput = stripAnsi(output);
  const candidates = extractUrlCandidates(cleanedOutput);
  if (candidates.length === 0) {
    return null;
  }

  const bestCandidate = candidates
    .map((candidate) => ({
      candidate,
      score: scoreServerUrlCandidate(cleanedOutput, candidate),
    }))
    .sort((left, right) => right.score - left.score)[0];

  if (!bestCandidate || bestCandidate.score < 1) {
    return null;
  }

  return normalizeParsedServerBaseUri(bestCandidate.candidate);
}

function extractUrlCandidates(output: string): string[] {
  return [...output.matchAll(/\bhttps?:\/\/[^\s"'`<>)\]}]+/gi)]
    .map((match) => sanitizeUrlCandidate(match[0] || ""))
    .filter(Boolean);
}

function sanitizeUrlCandidate(candidate: string): string {
  return candidate.replace(/[),.;]+$/g, "");
}

function scoreServerUrlCandidate(output: string, candidate: string): number {
  let score = 0;

  try {
    const url = new URL(candidate);
    const hostname = url.hostname.toLowerCase();
    const matchingLine =
      output
        .split(/\r?\n/)
        .find((line) => line.includes(candidate)) || "";

    if (isLocalServerHost(hostname)) {
      score += 100;
    }

    if (/\blocal\b/i.test(matchingLine)) {
      score += 120;
    }

    if (/\bnetwork\b/i.test(matchingLine)) {
      score -= 25;
    }

    if (/\bastro\b/i.test(output) || /\bLocal\b/.test(output)) {
      score += 10;
    }
  } catch {
    return 0;
  }

  return score;
}

function normalizeParsedServerBaseUri(candidate: string): vscode.Uri | null {
  try {
    const url = new URL(candidate);
    let hostname = url.hostname;

    if (
      hostname === "0.0.0.0" ||
      hostname === "::" ||
      hostname === "[::]" ||
      hostname === "[::1]"
    ) {
      hostname = "127.0.0.1";
    }

    const authority = url.port ? `${hostname}:${url.port}` : hostname;
    return vscode.Uri.parse(`${url.protocol}//${authority}`);
  } catch {
    return null;
  }
}

function isLocalServerHost(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase();
  return (
    normalizedHostname === "localhost" ||
    normalizedHostname === "0.0.0.0" ||
    normalizedHostname === "::" ||
    normalizedHostname === "[::]" ||
    normalizedHostname === "[::1]" ||
    normalizedHostname.startsWith("127.")
  );
}

function stripAnsi(output: string): string {
  return output.replace(
    // eslint-disable-next-line no-control-regex
    /\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g,
    "",
  );
}

function readSchoolOptions(
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

function renderCreateExamPageViewHtml(
  _webview: vscode.Webview,
  state: CreateExamPageViewState,
): string {
  const nonce = createNonce();
  const serializedState = JSON.stringify(state).replace(/</g, "\\u003c");
  const schoolsMarkup = state.schools.length
    ? state.schools
        .map(
          (school) => `
            <label class="school-option">
              <input type="checkbox" name="colleges" value="${escapeAttribute(school)}" />
              <span>${escapeHtml(school)}</span>
            </label>`,
        )
        .join("")
    : '<p class="empty-note">未读取到学院列表，将只创建基础 frontmatter。</p>';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      color-scheme: light dark;
      --accent: #0f766e;
      --accent-soft: color-mix(in srgb, var(--accent) 15%, transparent);
      --border: var(--vscode-input-border, rgba(127, 127, 127, 0.35));
      --muted: var(--vscode-descriptionForeground);
    }
    body {
      margin: 0;
      padding: 16px;
      font: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: linear-gradient(180deg, var(--vscode-sideBar-background), color-mix(in srgb, var(--vscode-sideBar-background) 85%, var(--accent-soft)));
    }
    h1 { margin: 0 0 12px; font-size: 15px; }
    p { margin: 0; color: var(--muted); line-height: 1.45; }
    form { display: grid; gap: 14px; margin-top: 16px; }
    .row { display: grid; gap: 10px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .field { display: grid; gap: 6px; }
    label { font-size: 12px; font-weight: 600; }
    input, select, textarea, button { font: inherit; }
    input, select, textarea {
      width: 100%;
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: color-mix(in srgb, var(--vscode-input-background) 92%, var(--accent-soft));
      color: var(--vscode-input-foreground);
      box-sizing: border-box;
    }
    .school-grid {
      display: grid;
      gap: 8px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      padding: 10px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: color-mix(in srgb, var(--vscode-editorWidget-background) 92%, var(--accent-soft));
      max-height: 190px;
      overflow: auto;
    }
    .school-option { display: flex; gap: 8px; align-items: flex-start; font-size: 12px; font-weight: 400; }
    .school-option input { width: auto; margin-top: 2px; }
    .preview-card, .message-card, .error-card {
      border-radius: 12px;
      border: 1px solid var(--border);
      padding: 12px;
      background: color-mix(in srgb, var(--vscode-editorWidget-background) 90%, var(--accent-soft));
    }
    .preview-card strong {
      display: block;
      margin-bottom: 6px;
      font-size: 12px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .preview-value { font-size: 13px; line-height: 1.5; word-break: break-all; }
    .error-card { display: none; border-color: color-mix(in srgb, #dc2626 50%, var(--border)); }
    .error-card.visible { display: block; }
    .error-card ul { margin: 0; padding-left: 18px; }
    .message-card { display: none; border-color: color-mix(in srgb, var(--accent) 35%, var(--border)); }
    .message-card.visible { display: block; }
    .actions { display: flex; gap: 8px; align-items: center; }
    button[type="submit"] {
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 9px 14px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      cursor: pointer;
      font-weight: 600;
    }
    button[type="submit"]:hover {
      background: var(--vscode-button-hoverBackground);
    }
    button[disabled] { opacity: 0.6; cursor: wait; }
    .muted-note, .empty-note { font-size: 12px; color: var(--muted); line-height: 1.5; }
    @media (max-width: 520px) {
      .row, .school-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <h1>新建试题页面</h1>
  <p>根据维基目录规则生成 <code>exams/&lt;name&gt;/index.mdx</code>，并自动打开预览。</p>

  <form id="create-form">
    <div class="row">
      <div class="field">
        <label for="startYear">开始年份</label>
        <input id="startYear" name="startYear" type="number" min="2000" max="2099" value="${escapeAttribute(String(state.defaults.startYear))}" />
      </div>
      <div class="field">
        <label for="endYear">结束年份</label>
        <input id="endYear" name="endYear" type="number" min="2001" max="2100" value="${escapeAttribute(String(state.defaults.endYear))}" />
      </div>
    </div>

    <div class="row">
      <div class="field">
        <label for="term">学期</label>
        <select id="term" name="term">
          ${TERM_VALUES.map((value) => `<option value="${value}" ${state.defaults.term === value ? "selected" : ""}>${value} · ${TERM_LABELS[value]}</option>`).join("")}
        </select>
      </div>
      <div class="field">
        <label for="stage">阶段</label>
        <select id="stage" name="stage">
          ${STAGE_VALUES.map((value) => `<option value="${value}" ${state.defaults.stage === value ? "selected" : ""}>${value}</option>`).join("")}
        </select>
      </div>
    </div>

    <div class="field">
      <label for="subject">课程名称</label>
      <input id="subject" name="subject" type="text" placeholder="例如：线性代数" value="${escapeAttribute(state.defaults.subject)}" />
    </div>

    <div class="row">
      <div class="field">
        <label for="type">类型</label>
        <select id="type" name="type">
          ${TYPE_VALUES.map((value) => `<option value="${value}" ${state.defaults.type === value ? "selected" : ""}>${value}</option>`).join("")}
        </select>
      </div>
      <div class="field">
        <label for="answerCompleteness">答案完成度</label>
        <select id="answerCompleteness" name="answerCompleteness">
          <option value="">不填写</option>
          ${ANSWER_COMPLETENESS_VALUES.map((value) => `<option value="${value}">${value}</option>`).join("")}
        </select>
      </div>
    </div>

    <div class="field">
      <label for="remark">备注（可选）</label>
      <input id="remark" name="remark" type="text" placeholder="例如：A卷 / 国际学院" value="${escapeAttribute(state.defaults.remark)}" />
    </div>

    <div class="field">
      <label for="source">来源 md5（可选）</label>
      <input id="source" name="source" type="text" maxlength="32" placeholder="32 位小写 md5" value="${escapeAttribute(state.defaults.source)}" />
    </div>

    <div class="field">
      <label>学院（可选）</label>
      <div class="school-grid">${schoolsMarkup}</div>
      <div class="muted-note">学院会写入 YAML 列表；不勾选时会省略该字段。</div>
    </div>

    <div class="preview-card">
      <strong>目录名预览</strong>
      <div class="preview-value" id="name-preview">-</div>
    </div>

    <div class="preview-card">
      <strong>时间字段预览</strong>
      <div class="preview-value" id="time-preview">-</div>
    </div>

    <div class="error-card" id="errors"></div>
    <div class="message-card" id="message"></div>

    <div class="actions">
      <button type="submit" id="submit-button">创建并预览</button>
      <span class="muted-note">会自动创建目录、写入模板并打开预览。</span>
    </div>
  </form>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = ${serializedState};
    const form = document.getElementById("create-form");
    const errors = document.getElementById("errors");
    const message = document.getElementById("message");
    const submitButton = document.getElementById("submit-button");
    const namePreview = document.getElementById("name-preview");
    const timePreview = document.getElementById("time-preview");

    function normalizeRemark(value) {
      return value.trim().replace(/^[（(]\\s*/, "").replace(/\\s*[）)]$/, "").trim();
    }
    function padYear(year) {
      return String(year).slice(-2).padStart(2, "0");
    }
    function collectPayload() {
      return {
        startYear: form.startYear.value,
        endYear: form.endYear.value,
        term: form.term.value,
        subject: form.subject.value.trim(),
        stage: form.stage.value,
        type: form.type.value,
        remark: form.remark.value,
        source: form.source.value.trim().toLowerCase(),
        answerCompleteness: form.answerCompleteness.value,
        colleges: [...form.querySelectorAll('input[name="colleges"]:checked')].map((input) => input.value),
      };
    }
    function computeErrors(payload) {
      const problems = [];
      const startYear = Number.parseInt(payload.startYear, 10);
      const endYear = Number.parseInt(payload.endYear, 10);
      if (!Number.isInteger(startYear) || String(startYear).length !== 4) problems.push("开始年份必须是四位数字。");
      if (!Number.isInteger(endYear) || String(endYear).length !== 4) problems.push("结束年份必须是四位数字。");
      if (Number.isInteger(startYear) && Number.isInteger(endYear) && endYear !== startYear + 1) problems.push("结束年份必须等于开始年份 + 1。");
      if (!payload.subject) problems.push("课程名称不能为空。");
      if (/[\\\\/:*?"<>|]/.test(payload.subject)) problems.push("课程名称不能包含文件系统保留字符。");
      if (payload.source && !/^[0-9a-f]{32}$/.test(payload.source)) problems.push("来源必须是 32 位小写 md5。");
      if (normalizeRemark(payload.remark) && /[\\\\/:*?"<>|]/.test(normalizeRemark(payload.remark))) problems.push("备注不能包含文件系统保留字符。");
      return problems;
    }
    function renderErrors(problems) {
      if (!problems.length) {
        errors.className = "error-card";
        errors.innerHTML = "";
        return;
      }
      errors.className = "error-card visible";
      errors.innerHTML = "<ul>" + problems.map((problem) => "<li>" + problem + "</li>").join("") + "</ul>";
    }
    function renderMessage(text) {
      if (!text) {
        message.className = "message-card";
        message.textContent = "";
        return;
      }
      message.className = "message-card visible";
      message.textContent = text;
    }
    function updatePreview() {
      const payload = collectPayload();
      const problems = computeErrors(payload);
      renderErrors(problems);
      const startYear = Number.parseInt(payload.startYear, 10);
      const endYear = Number.parseInt(payload.endYear, 10);
      const remark = normalizeRemark(payload.remark);
      if (Number.isInteger(startYear) && Number.isInteger(endYear) && payload.subject) {
        const name = [padYear(startYear), padYear(endYear), payload.term, payload.subject, payload.stage].join("-") + (remark ? "（" + remark + "）" : "");
        namePreview.textContent = name;
      } else {
        namePreview.textContent = "输入完整信息后自动生成";
      }
      if (Number.isInteger(startYear) && Number.isInteger(endYear)) {
        timePreview.textContent = startYear + "-" + endYear + "学年第" + (payload.term === "1" ? "一" : "二") + "学期";
      } else {
        timePreview.textContent = "输入年份后自动生成";
      }
      return problems.length === 0;
    }
    function setBusy(busy) {
      submitButton.disabled = busy;
      submitButton.textContent = busy ? "正在创建..." : "创建并预览";
    }
    form.addEventListener("input", () => {
      renderMessage("");
      updatePreview();
    });
    form.addEventListener("change", () => {
      renderMessage("");
      updatePreview();
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const payload = collectPayload();
      const problems = computeErrors(payload);
      renderErrors(problems);
      if (problems.length > 0) return;
      setBusy(true);
      renderMessage("");
      vscode.postMessage({ type: "createExamPage", payload });
    });
    window.addEventListener("message", (event) => {
      const message = event.data;
      if (!message || typeof message.type !== "string") return;
      if (message.type === "created") {
        setBusy(false);
        renderMessage("已创建并打开：" + message.examName);
      }
      if (message.type === "createError") {
        setBusy(false);
        renderMessage(message.message || "创建失败。");
      }
    });
    updatePreview();
  </script>
</body>
</html>`;
}

function renderPreviewPanelHtml(
  _webview: vscode.Webview,
  state: PreviewPanelState,
): string {
  const previewOrigin = state.previewUrl
    ? getUriOrigin(state.previewUrl)
    : "http: https:";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; frame-src ${previewOrigin};" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      color-scheme: light dark;
      --accent: #0f766e;
      --muted: var(--vscode-descriptionForeground);
    }
    body {
      margin: 0;
      font: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    .frame {
      width: 100%;
      height: 100vh;
      border: 0;
      background: white;
    }
    .loading {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      box-sizing: border-box;
    }
    .loading-inner {
      display: grid;
      justify-items: center;
      gap: 16px;
    }
    .spinner {
      width: 28px;
      height: 28px;
      border-radius: 999px;
      border: 3px solid color-mix(in srgb, var(--accent) 20%, var(--vscode-editorWidget-border, transparent));
      border-top-color: var(--accent);
      animation: spin 0.8s linear infinite;
    }
    .status {
      font-size: 13px;
      color: var(--muted);
      letter-spacing: 0.01em;
    }
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  ${
    state.status === "ready"
      ? `<iframe class="frame" src="${escapeAttribute(state.previewUrl)}"></iframe>`
      : `<div class="loading">
          <div class="loading-inner">
            ${
              state.status === "starting"
                ? '<div class="spinner" aria-hidden="true"></div>'
                : ""
            }
            <div class="status">${escapeHtml(renderPreviewStatusText(state))}</div>
          </div>
        </div>`
  }
</body>
</html>`;
}

function renderPreviewStatusText(state: PreviewPanelState): string {
  if (state.statusDetail) {
    return state.statusDetail;
  }

  if (state.status === "ready") {
    return "预览已连接";
  }

  if (state.status === "timeout") {
    return "预览连接超时";
  }

  return "正在启动预览服务";
}

async function refreshEnabledContext(): Promise<void> {
  await vscode.commands.executeCommand(
    "setContext",
    "byrdocsWiki.enabled",
    hasWikiWorkspace(),
  );
}

function reviveUri(value: unknown): vscode.Uri | null {
  if (value instanceof vscode.Uri) {
    return value;
  }

  const record = asRecord(value);
  if (
    typeof record.scheme === "string" &&
    typeof record.path === "string"
  ) {
    return vscode.Uri.from({
      scheme: record.scheme,
      authority: typeof record.authority === "string" ? record.authority : "",
      path: record.path,
      query: typeof record.query === "string" ? record.query : "",
      fragment: typeof record.fragment === "string" ? record.fragment : "",
    });
  }

  return null;
}

function sleep(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

async function waitForTerminalShellIntegration(
  terminal: vscode.Terminal,
  timeoutMs: number,
): Promise<vscode.TerminalShellIntegration | null> {
  if (terminal.shellIntegration) {
    return terminal.shellIntegration;
  }

  return new Promise((resolve) => {
    const disposable = vscode.window.onDidChangeTerminalShellIntegration(
      (event) => {
        if (event.terminal !== terminal) {
          return;
        }

        cleanup();
        resolve(event.shellIntegration);
      },
    );
    const timeoutHandle = setTimeout(() => {
      cleanup();
      resolve(terminal.shellIntegration || null);
    }, timeoutMs);

    const cleanup = (): void => {
      disposable.dispose();
      clearTimeout(timeoutHandle);
    };
  });
}

async function waitForServerUri(
  baseUri: vscode.Uri,
  timeoutMs: number,
  intervalMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pingServer(baseUri)) {
      return true;
    }

    await sleep(intervalMs);
  }

  return false;
}

function appendPathToUri(baseUri: vscode.Uri, extraPath: string): vscode.Uri {
  const normalizedBasePath = baseUri.path.endsWith("/")
    ? baseUri.path.slice(0, -1)
    : baseUri.path;
  return baseUri.with({
    path: `${normalizedBasePath}${extraPath.startsWith("/") ? extraPath : `/${extraPath}`}`,
  });
}

function clearDocumentState(uri: vscode.Uri): void {
  documentStateCache.delete(uri.toString());
}

function createNonce(): string {
  return (
    Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  );
}

function escapeAttribute(text: string): string {
  return escapeHtml(text).replaceAll('"', "&quot;");
}

function escapeHtml(text: string): string {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function extractExistingAttributes(source: string): string[] {
  return [...source.matchAll(/([A-Za-z][\w-]*)(?=(?:\s*=|\s|$))/g)]
    .map((match) => match[1] || "")
    .filter(Boolean);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPreviewPanelMessage(value: unknown): value is PreviewPanelMessage {
  const record = asRecord(value);
  return record.type === "reload" || record.type === "openExternal";
}

function isCreateExamPageWebviewMessage(
  value: unknown,
): value is CreateExamPageWebviewMessage {
  const record = asRecord(value);
  return record.type === "createExamPage";
}

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
