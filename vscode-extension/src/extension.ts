import * as path from "node:path";
import * as vscode from "vscode";
import { clearDocumentState } from "./documentState";
import {
  DOCUMENT_SELECTOR,
  CREATE_EXAM_PAGE_VIEW_ID,
  SEMANTIC_LEGEND,
} from "./constants";
import {
  createCompletionProvider,
  createDefinitionProvider,
  createFoldingRangeProvider,
  createHoverProvider,
  createInlayHintsProvider,
  createSemanticTokensProvider,
  toggleChoiceCorrectness,
} from "./language/providers";
import {
  refreshAllOpenFigureDiagnostics,
  updateFigureDiagnostics,
} from "./language/diagnostics";
import { ExamPreviewManager } from "./preview/manager";
import { getExamPreviewTarget } from "./preview/targets";
import { CreateExamPageViewProvider } from "./sidebar/viewProvider";
import {
  ensureEnabledWorkspace,
  getCommandTargetUri,
  getWikiWorkspaceFolders,
  refreshEnabledContext,
} from "./workspace";

let previewManager: ExamPreviewManager;
let createExamPageViewProvider: CreateExamPageViewProvider;
let figureDiagnosticCollection: vscode.DiagnosticCollection;
let outputChannel: vscode.OutputChannel;
let sidebarRefreshTimer: NodeJS.Timeout | null = null;
let examIndexWatchers: vscode.FileSystemWatcher[] = [];

export function activate(context: vscode.ExtensionContext): void {
  previewManager = new ExamPreviewManager();
  createExamPageViewProvider = new CreateExamPageViewProvider(previewManager);
  figureDiagnosticCollection =
    vscode.languages.createDiagnosticCollection("byrdocsWikiFigure");
  outputChannel = vscode.window.createOutputChannel("BYR Docs Wiki");

  resetExamIndexWatchers();

  context.subscriptions.push(
    figureDiagnosticCollection,
    outputChannel,
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

        await createExamPageViewProvider.reveal("create");
      },
    ),
    vscode.commands.registerCommand(
      "byrdocsWiki.refreshExamList",
      async () => {
        await refreshEnabledContext();
        if (!ensureEnabledWorkspace()) {
          return;
        }

        scheduleExamListRefresh("manual command");
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
      updateFigureDiagnostics(figureDiagnosticCollection, event.document);
      previewManager.handleDocumentChange(event.document);
    }),
    vscode.workspace.onDidOpenTextDocument((document) => {
      updateFigureDiagnostics(figureDiagnosticCollection, document);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      clearDocumentState(document.uri);
      figureDiagnosticCollection.delete(document.uri);
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      clearDocumentState(document.uri);
      updateFigureDiagnostics(figureDiagnosticCollection, document);
      previewManager.handleDocumentChange(document);
      const match = getExamResourceMatch(document.uri);
      if (match.indexFile) {
        logOutput("save", document.uri, describeExamResourceMatch(match));
        scheduleExamListRefresh("text document saved", document.uri);
      }
      if (path.basename(document.fileName) === "package.json") {
        void refreshEnabledContext();
      }
    }),
    vscode.workspace.onDidCreateFiles((event) => {
      for (const uri of event.files) {
        const match = getExamResourceMatch(uri);
        logOutput("workspace create", uri, describeExamResourceMatch(match));
        if (!match.related) {
          continue;
        }
        scheduleExamListRefresh("workspace create", uri);
      }
    }),
    vscode.workspace.onDidDeleteFiles((event) => {
      for (const uri of event.files) {
        const match = getExamResourceMatch(uri);
        logOutput("workspace delete", uri, describeExamResourceMatch(match));
        if (!match.related) {
          continue;
        }
        scheduleExamListRefresh("workspace delete", uri);
      }
    }),
    vscode.workspace.onDidRenameFiles((event) => {
      for (const item of event.files) {
        const oldMatch = getExamResourceMatch(item.oldUri);
        logOutput(
          "workspace rename old",
          item.oldUri,
          describeExamResourceMatch(oldMatch),
        );
        if (oldMatch.related) {
          scheduleExamListRefresh("workspace rename old", item.oldUri);
        }
        const newMatch = getExamResourceMatch(item.newUri);
        logOutput(
          "workspace rename new",
          item.newUri,
          describeExamResourceMatch(newMatch),
        );
        if (newMatch.related) {
          scheduleExamListRefresh("workspace rename new", item.newUri);
        }
      }
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      previewManager.handleEditorSelectionChanged(event.textEditor);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      previewManager.handleEditorSelectionChanged(editor);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void refreshEnabledContext();
      resetExamIndexWatchers();
      createExamPageViewProvider.refresh();
      refreshAllOpenFigureDiagnostics(figureDiagnosticCollection);
    }),
    new vscode.Disposable(() => {
      if (sidebarRefreshTimer) {
        clearTimeout(sidebarRefreshTimer);
        sidebarRefreshTimer = null;
      }
      disposeExamIndexWatchers();
    }),
  );

  logOutput("activate");
  void refreshEnabledContext();
  refreshAllOpenFigureDiagnostics(figureDiagnosticCollection);
}

export function deactivate(): void {}

function getExamResourceMatch(uri: vscode.Uri): {
  readonly indexFile: boolean;
  readonly related: boolean;
} {
  if (getExamPreviewTarget(uri) !== null) {
    return {
      indexFile: true,
      related: true,
    };
  }

  if (uri.scheme !== "file") {
    return {
      indexFile: false,
      related: false,
    };
  }

  for (const workspaceFolder of getWikiWorkspaceFolders()) {
    const relativePath = path.relative(workspaceFolder.uri.fsPath, uri.fsPath);
    if (
      !relativePath ||
      relativePath.startsWith("..") ||
      path.isAbsolute(relativePath)
    ) {
      continue;
    }

    const normalizedRelativePath = relativePath.split(path.sep).join("/");
    if (
      normalizedRelativePath === "exams" ||
      normalizedRelativePath.startsWith("exams/")
    ) {
      return {
        indexFile: false,
        related: true,
      };
    }
  }

  return {
    indexFile: false,
    related: false,
  };
}

function resetExamIndexWatchers(): void {
  disposeExamIndexWatchers();

  for (const workspaceFolder of getWikiWorkspaceFolders()) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceFolder, "exams/**"),
    );

    logOutput("register watcher", workspaceFolder.uri, "exams/**");

    watcher.onDidCreate((uri) => {
      const match = getExamResourceMatch(uri);
      logOutput("fs watcher create", uri, describeExamResourceMatch(match));
      if (!match.related) {
        return;
      }
      scheduleExamListRefresh("fs watcher create", uri);
      refreshAllOpenFigureDiagnostics(figureDiagnosticCollection);
    });

    watcher.onDidDelete((uri) => {
      const match = getExamResourceMatch(uri);
      logOutput("fs watcher delete", uri, describeExamResourceMatch(match));
      if (!match.related) {
        return;
      }
      scheduleExamListRefresh("fs watcher delete", uri);
      refreshAllOpenFigureDiagnostics(figureDiagnosticCollection);
    });

    watcher.onDidChange((uri) => {
      const match = getExamResourceMatch(uri);
      logOutput("fs watcher change", uri, describeExamResourceMatch(match));
      if (!match.related) {
        return;
      }
      scheduleExamListRefresh("fs watcher change", uri);
      refreshAllOpenFigureDiagnostics(figureDiagnosticCollection);
    });

    examIndexWatchers.push(watcher);
  }
}

function disposeExamIndexWatchers(): void {
  for (const watcher of examIndexWatchers) {
    watcher.dispose();
  }
  examIndexWatchers = [];
}

function scheduleExamListRefresh(
  reason: string,
  uri?: vscode.Uri,
): void {
  if (sidebarRefreshTimer) {
    clearTimeout(sidebarRefreshTimer);
  }

  sidebarRefreshTimer = setTimeout(() => {
    sidebarRefreshTimer = null;
    logOutput("refresh exam list", uri, reason);
    createExamPageViewProvider.refresh();
  }, 60);
}

function logOutput(kind: string, uri?: vscode.Uri, detail?: string): void {
  const timestamp = new Date().toISOString();
  const segments = [`[${timestamp}]`, kind];
  if (detail) {
    segments.push(`(${detail})`);
  }
  if (uri) {
    segments.push(uri.fsPath || uri.toString());
  }
  outputChannel.appendLine(segments.join(" "));
}

function describeExamResourceMatch(match: {
  readonly indexFile: boolean;
  readonly related: boolean;
}): string {
  if (match.indexFile) {
    return "index.mdx";
  }
  if (match.related) {
    return "exam path";
  }
  return "ignored";
}


