import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  PREVIEW_SERVER_HOST,
  PREVIEW_SERVER_PORT_SEARCH_LIMIT,
  PREVIEW_SERVER_START_PORT,
  PREVIEW_TERMINAL_NAME,
  SERVER_DETECTION_TIMEOUT_MS,
  SERVER_PING_INTERVAL_MS,
  SERVER_RECONNECT_INTERVAL_MS,
  SERVER_RECONNECT_TIMEOUT_MS,
  SHELL_INTEGRATION_WAIT_MS,
  UNRESOLVED_SERVER_ORIGIN_LABEL,
} from "../constants";
import { getDocumentState } from "../documentState";
import {
  buildPreviewSyncAstroConfigSource,
  buildPreviewSyncBlocks,
  buildPreviewSyncInjectedPageScript,
  buildPreviewSyncVitePluginSource,
  findAstroConfigPath,
  type PreviewSyncPosition,
} from "../lib/previewSync";
import { asRecord } from "../utils/common";
import { getCommandTargetUri, getWikiWorkspaceFolderForUri } from "../workspace";
import { appendPathToUri, getAdjacentPreviewViewColumn, getAdjacentSourceViewColumn, pickClosestViewColumn } from "./layout";
import { renderPreviewPanelHtml } from "./panelHtml";
import {
  findAvailableLocalServerBaseUri,
  parseServerBaseUriFromTerminalOutput,
  pingServer,
  waitForServerUri,
  waitForTerminalShellIntegration,
} from "./server";
import { getExamPreviewTarget } from "./targets";
import type {
  ExamPreviewTarget,
  PreviewPanelMessage,
  PreviewPanelOpenSourceLocationMessage,
  PreviewPanelSyncState,
  PreviewPanelSyncUpdateMessage,
  PreviewStatus,
} from "./types";

export class ExamPreviewManager {
  private currentExam: ExamPreviewTarget | null = null;
  private readonly injectedPageScriptSource = buildPreviewSyncInjectedPageScript();
  private readonly injectedVitePluginSource = buildPreviewSyncVitePluginSource(
    this.injectedPageScriptSource,
  );
  private localServerBaseUri: vscode.Uri | null = null;
  private externalBaseUri: vscode.Uri | null = null;
  private panel: vscode.WebviewPanel | null = null;
  private previewViewColumn: vscode.ViewColumn | undefined = vscode.ViewColumn.Two;
  private serverReady = false;
  private sourceViewColumn: vscode.ViewColumn | undefined = vscode.ViewColumn.One;
  private statusDetail = "";
  private suppressSelectionSyncCount = 0;
  private suppressSelectionSyncTimeout: NodeJS.Timeout | null = null;
  private syncUpdateTimer: NodeJS.Timeout | null = null;
  private terminal: vscode.Terminal | null = null;
  private serverOriginParsePromise: Promise<vscode.Uri | null> | null = null;
  private waitForServerPromise: Promise<boolean> | null = null;

  async preview(
    resourceUri: vscode.Uri | null,
    options: { readonly focusPreview?: boolean } = {},
  ): Promise<void> {
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
    const sourceEditor = this.findVisibleTextEditorForUri(targetUri);
    if (sourceEditor?.viewColumn) {
      this.sourceViewColumn = sourceEditor.viewColumn;
    }
    const panel = this.ensurePanel(options.focusPreview ?? true);
    panel.title = `预览: ${examTarget.examName}`;
    this.statusDetail = "启动终端";
    await this.updatePanel("starting");

    await this.ensureServer();
    const ready = await this.waitForServer();
    if (!this.panel || !this.currentExam) {
      return;
    }

    await this.updatePanel(ready ? "ready" : "timeout");
    if (ready) {
      await this.pushPreviewSyncState();
    }
  }

  async showSourceDocument(
    fileUri: vscode.Uri,
    options: { readonly preserveFocus?: boolean } = {},
  ): Promise<vscode.TextEditor> {
    const document = await vscode.workspace.openTextDocument(fileUri);
    const editor = await vscode.window.showTextDocument(document, {
      preview: false,
      preserveFocus: options.preserveFocus ?? false,
      viewColumn: this.getPreferredSourceViewColumn(fileUri),
    });
    if (editor.viewColumn) {
      this.sourceViewColumn = editor.viewColumn;
    }
    return editor;
  }

  handleDocumentChange(document: vscode.TextDocument): void {
    if (
      !this.currentExam ||
      document.uri.toString() !== this.currentExam.fileUri.toString()
    ) {
      return;
    }

    this.schedulePreviewSyncStatePush();
  }

  handleEditorSelectionChanged(editor: vscode.TextEditor | undefined): void {
    if (
      !this.currentExam ||
      !editor ||
      editor.document.uri.toString() !== this.currentExam.fileUri.toString()
    ) {
      return;
    }

    if (editor.viewColumn) {
      this.sourceViewColumn = editor.viewColumn;
    }
    if (this.suppressSelectionSyncCount > 0) {
      this.suppressSelectionSyncCount -= 1;
      return;
    }
    this.schedulePreviewSyncStatePush();
  }

  private ensurePanel(focusPreview: boolean): vscode.WebviewPanel {
    if (this.panel) {
      this.panel.reveal(this.getPreferredPreviewViewColumn(), !focusPreview);
      return this.panel;
    }

    this.panel = vscode.window.createWebviewPanel(
      "byrdocsWiki.preview",
      "BYR Docs Wiki Preview",
      {
        preserveFocus: !focusPreview,
        viewColumn: this.getPreferredPreviewViewColumn(),
      },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );
    if (this.panel.viewColumn) {
      this.previewViewColumn = this.panel.viewColumn;
    }

    this.panel.onDidChangeViewState((event) => {
      if (event.webviewPanel.viewColumn) {
        this.previewViewColumn = event.webviewPanel.viewColumn;
      }
    });

    this.panel.onDidDispose(() => {
      if (this.suppressSelectionSyncTimeout) {
        clearTimeout(this.suppressSelectionSyncTimeout);
        this.suppressSelectionSyncTimeout = null;
      }
      if (this.syncUpdateTimer) {
        clearTimeout(this.syncUpdateTimer);
        this.syncUpdateTimer = null;
      }
      this.panel = null;
    });

    this.panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (isPreviewPanelOpenSourceLocationMessage(message)) {
        await this.openSourceLocation(message.position);
        return;
      }

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

  private getPreferredSourceViewColumn(
    documentUri: vscode.Uri,
  ): vscode.ViewColumn {
    const visibleColumns = vscode.window.visibleTextEditors
      .map((editor) => editor.viewColumn)
      .filter((viewColumn): viewColumn is vscode.ViewColumn =>
        typeof viewColumn === "number",
      )
      .sort((left, right) => left - right);
    if (visibleColumns.length === 0) {
      return vscode.ViewColumn.One;
    }

    const matchingEditor = this.findVisibleTextEditorForUri(documentUri);
    if (matchingEditor?.viewColumn) {
      return matchingEditor.viewColumn;
    }

    const previewColumn = this.panel?.viewColumn || this.previewViewColumn;
    if (previewColumn) {
      const nonPreviewColumns = visibleColumns.filter(
        (viewColumn) => viewColumn !== previewColumn,
      );
      if (nonPreviewColumns.length > 0) {
        return pickClosestViewColumn(nonPreviewColumns, previewColumn);
      }
      return getAdjacentSourceViewColumn(previewColumn);
    }

    const activeEditor = vscode.window.activeTextEditor;
    if (
      activeEditor?.viewColumn &&
      visibleColumns.includes(activeEditor.viewColumn)
    ) {
      return activeEditor.viewColumn;
    }

    if (
      this.sourceViewColumn &&
      visibleColumns.includes(this.sourceViewColumn)
    ) {
      return this.sourceViewColumn;
    }
    return visibleColumns[0] || vscode.ViewColumn.One;
  }

  private getPreferredPreviewViewColumn(): vscode.ViewColumn {
    if (this.panel?.viewColumn) {
      return this.panel.viewColumn;
    }

    const sourceEditor = this.currentExam
      ? this.findVisibleTextEditorForUri(this.currentExam.fileUri)
      : undefined;
    if (sourceEditor?.viewColumn) {
      return getAdjacentPreviewViewColumn(
        sourceEditor.viewColumn,
        this.previewViewColumn,
      );
    }

    if (this.sourceViewColumn) {
      return getAdjacentPreviewViewColumn(
        this.sourceViewColumn,
        this.previewViewColumn,
      );
    }

    if (this.previewViewColumn) {
      return this.previewViewColumn;
    }

    return vscode.ViewColumn.Two;
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

    if (
      this.serverReady &&
      this.localServerBaseUri &&
      (await this.tryReconnectServer(this.localServerBaseUri))
    ) {
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
      this.terminal.dispose();
      this.terminal = null;
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
    this.waitForServerPromise = null;
    const previewServerBaseUri = await findAvailableLocalServerBaseUri(
      PREVIEW_SERVER_HOST,
      PREVIEW_SERVER_START_PORT,
      PREVIEW_SERVER_PORT_SEARCH_LIMIT,
    );
    if (!previewServerBaseUri) {
      this.statusDetail = "Failed to allocate preview port";
      await this.updatePanel("starting");
      return;
    }

    this.localServerBaseUri = previewServerBaseUri;
    this.serverOriginParsePromise = Promise.resolve(previewServerBaseUri);
    const previewCommand = await this.buildPreviewCommand(
      workspaceFolder,
      previewServerBaseUri,
    );
    for (const terminal of vscode.window.terminals) {
      if (terminal.name === PREVIEW_TERMINAL_NAME) {
        terminal.dispose();
      }
    }
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
      this.terminal.sendText(previewCommand);
      this.terminal.show(true);
      await this.updatePanel("starting");
      return;
    }

    this.statusDetail = "启动开发服务器";
    await this.updatePanel("starting");
    shellIntegration.executeCommand(previewCommand);
    this.terminal.show(true);
  }

  private async tryReconnectServer(baseUri: vscode.Uri): Promise<boolean> {
    this.statusDetail = "连接开发服务器";
    await this.updatePanel("starting");
    const ready = await waitForServerUri(
      baseUri,
      SERVER_RECONNECT_TIMEOUT_MS,
      SERVER_RECONNECT_INTERVAL_MS,
    );
    if (!ready) {
      this.statusDetail = "重新启动开发服务器";
      await this.updatePanel("starting");
    }
    return ready;
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
    const syncState =
      status === "ready" ? await this.getPreviewSyncState() : null;
    this.panel.webview.html = renderPreviewPanelHtml(this.panel.webview, {
      examName: this.currentExam.examName,
      previewUrl: previewUri?.toString() || "",
      routePath: this.currentExam.routePath,
      serverOrigin:
        this.localServerBaseUri?.toString() || UNRESOLVED_SERVER_ORIGIN_LABEL,
      status,
      statusDetail: this.statusDetail,
      syncState,
      terminalName: PREVIEW_TERMINAL_NAME,
    });
  }

  private async buildPreviewCommand(
    workspaceFolder: vscode.WorkspaceFolder,
    baseUri: vscode.Uri,
  ): Promise<string> {
    const serverUrl = new URL(baseUri.toString());
    const host = serverUrl.hostname;
    const port = serverUrl.port || "4321";
    const previewConfigPath = await this.ensurePreviewSyncRuntime(workspaceFolder);
    if (!previewConfigPath) {
      return `pnpm i && pnpm exec astro dev --host ${host} --port ${port} --strictPort`;
    }

    const relativeConfigPath = path.relative(
      workspaceFolder.uri.fsPath,
      previewConfigPath,
    );
    return `pnpm i && pnpm exec astro --config ${JSON.stringify(relativeConfigPath)} dev --host ${host} --port ${port} --strictPort`;
  }

  private async ensurePreviewSyncRuntime(
    workspaceFolder: vscode.WorkspaceFolder,
  ): Promise<string | null> {
    const originalConfigPath = findAstroConfigPath(
      workspaceFolder,
      fs.existsSync,
    );
    if (!originalConfigPath) {
      return null;
    }

    const runtimeDirectory = path.join(
      workspaceFolder.uri.fsPath,
      "node_modules",
      ".byrdocs-wiki-preview-sync",
    );
    await fs.promises.mkdir(runtimeDirectory, { recursive: true });

    const pluginPath = path.join(runtimeDirectory, "vite.preview-sync.mjs");
    const configPath = path.join(runtimeDirectory, "astro.preview.config.mjs");

    await fs.promises.writeFile(
      pluginPath,
      this.injectedVitePluginSource,
      "utf8",
    );
    await fs.promises.writeFile(
      configPath,
      buildPreviewSyncAstroConfigSource(originalConfigPath, pluginPath),
      "utf8",
    );

    return configPath;
  }

  private async getPreviewSyncState(): Promise<PreviewPanelSyncState | null> {
    const document = await this.getPreviewDocument();
    if (!document) {
      return null;
    }

    return {
      blocks: buildPreviewSyncBlocks(document, getDocumentState(document)),
      position: this.getCurrentPreviewPosition(document),
    };
  }

  private getCurrentPreviewPosition(
    document: vscode.TextDocument,
  ): PreviewSyncPosition | null {
    const activeEditor = vscode.window.activeTextEditor;
    if (
      !activeEditor ||
      activeEditor.document.uri.toString() !== document.uri.toString()
    ) {
      return null;
    }

    return {
      character: activeEditor.selection.active.character,
      line: activeEditor.selection.active.line,
    };
  }

  private async getPreviewDocument(): Promise<vscode.TextDocument | null> {
    if (!this.currentExam) {
      return null;
    }

    const existingDocument = vscode.workspace.textDocuments.find(
      (document) =>
        document.uri.toString() === this.currentExam?.fileUri.toString(),
    );
    if (existingDocument) {
      return existingDocument;
    }

    try {
      return await vscode.workspace.openTextDocument(this.currentExam.fileUri);
    } catch {
      return null;
    }
  }

  private schedulePreviewSyncStatePush(): void {
    if (!this.panel || !this.currentExam || !this.serverReady) {
      return;
    }

    if (this.syncUpdateTimer) {
      clearTimeout(this.syncUpdateTimer);
    }

    this.syncUpdateTimer = setTimeout(() => {
      this.syncUpdateTimer = null;
      void this.pushPreviewSyncState();
    }, 80);
  }

  private async pushPreviewSyncState(): Promise<void> {
    if (!this.panel || !this.currentExam || !this.serverReady) {
      return;
    }

    const state = await this.getPreviewSyncState();
    const message: PreviewPanelSyncUpdateMessage = {
      state,
      type: "updateSyncState",
    };
    void this.panel.webview.postMessage(message);
  }

  private async openSourceLocation(position: PreviewSyncPosition): Promise<void> {
    if (!this.currentExam) {
      return;
    }

    const editor = this.findVisibleTextEditorForUri(this.currentExam.fileUri);
    if (!editor) {
      return;
    }

    const document = editor.document;
    const line = Math.min(
      Math.max(position.line, 0),
      Math.max(document.lineCount - 1, 0),
    );
    const lineLength = document.lineAt(line).text.length;
    const character = Math.min(Math.max(position.character, 0), lineLength);
    const targetPosition = new vscode.Position(line, character);
    this.suppressSelectionSyncCount = 2;
    if (this.suppressSelectionSyncTimeout) {
      clearTimeout(this.suppressSelectionSyncTimeout);
    }
    this.suppressSelectionSyncTimeout = setTimeout(() => {
      this.suppressSelectionSyncCount = 0;
      this.suppressSelectionSyncTimeout = null;
    }, 500);

    editor.selection = new vscode.Selection(targetPosition, targetPosition);
    editor.revealRange(
      new vscode.Range(targetPosition, targetPosition),
      vscode.TextEditorRevealType.InCenter,
    );
  }

  private findVisibleTextEditorForUri(
    documentUri: vscode.Uri,
  ): vscode.TextEditor | undefined {
    return vscode.window.visibleTextEditors
      .filter((editor) => editor.document.uri.toString() === documentUri.toString())
      .sort((left, right) => {
        const leftColumn = left.viewColumn || Number.MAX_SAFE_INTEGER;
        const rightColumn = right.viewColumn || Number.MAX_SAFE_INTEGER;
        return leftColumn - rightColumn;
      })[0];
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

function isPreviewPanelMessage(value: unknown): value is PreviewPanelMessage {
  const record = asRecord(value);
  return record.type === "reload" || record.type === "openExternal";
}

function isPreviewPanelOpenSourceLocationMessage(
  value: unknown,
): value is PreviewPanelOpenSourceLocationMessage {
  const record = asRecord(value);
  const position = asRecord(record.position);
  return (
    record.type === "openSourceLocation" &&
    typeof position.line === "number" &&
    typeof position.character === "number"
  );
}
