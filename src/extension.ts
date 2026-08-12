/**
 * Wiring: the tree view, the eight commands, the group-mode context key and the
 * active-editor listener that drives auto-reveal + read-only.
 */
import * as vscode from 'vscode';
import { ReadonlyManager } from './readonly';
import { errText } from './resolver';
import { ExternalLibrariesProvider, GroupMode, Node } from './tree';

const VIEW_ID = 'externalLibraries.view';
const MODE_STATE_KEY = 'externalLibraries.groupMode';
const MODE_CONTEXT_KEY = 'externalLibraries.groupMode';
const REVEAL_DEBOUNCE_MS = 150;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('External Libraries');
  context.subscriptions.push(log);

  const mode = context.globalState.get<GroupMode>(MODE_STATE_KEY, 'rez');
  const provider = new ExternalLibrariesProvider(mode === 'path' ? 'path' : 'rez', log);
  const readonly = new ReadonlyManager(context, log);

  const view = vscode.window.createTreeView<Node>(VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true,
    canSelectMany: false,
  });
  context.subscriptions.push(view);

  await setGroupModeContext(provider.groupMode);
  void readonly.probe();

  context.subscriptions.push(
    provider.onDidChangeSnapshot((snapshot) => {
      if (!snapshot) {
        view.message = undefined;
        return;
      }
      if (snapshot.error) {
        view.message = snapshot.error;
        return;
      }
      const count = snapshot.entries.length;
      const version = snapshot.pythonVersion ? `Python ${snapshot.pythonVersion}` : 'Python';
      view.message = undefined;
      view.title = `External Libraries`;
      view.description = `${version} · ${count} entries`;
    }),
  );

  /* ------------------------------------------------------------- commands */

  const setMode = async (next: GroupMode) => {
    provider.setGroupMode(next);
    await context.globalState.update(MODE_STATE_KEY, next);
    await setGroupModeContext(next);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('externalLibraries.refresh', async () => {
      await provider.refresh();
    }),
    vscode.commands.registerCommand('externalLibraries.groupByRez', () => setMode('rez')),
    vscode.commands.registerCommand('externalLibraries.groupByPath', () => setMode('path')),
    vscode.commands.registerCommand('externalLibraries.revealActiveFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showInformationMessage('External Libraries: no active editor.');
        return;
      }
      const revealed = await revealEditor(view, provider, editor, true);
      if (!revealed) {
        void vscode.window.showInformationMessage(
          'External Libraries: the active file is not under any sys.path root.',
        );
      }
    }),
    vscode.commands.registerCommand('externalLibraries.copyPath', async (node?: Node) => {
      const target = node ?? view.selection[0];
      const fsPath = nodePath(target);
      if (fsPath) {
        await vscode.env.clipboard.writeText(fsPath);
      }
    }),
    vscode.commands.registerCommand('externalLibraries.revealInExplorer', async (node?: Node) => {
      const target = node ?? view.selection[0];
      const fsPath = nodePath(target);
      if (fsPath) {
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(fsPath));
      }
    }),
    vscode.commands.registerCommand('externalLibraries.showLog', () => log.show(true)),
    vscode.commands.registerCommand('externalLibraries.clearReadonlyGlobs', async () => {
      const removed = await readonly.clearWrittenGlobs();
      void vscode.window.showInformationMessage(
        removed > 0
          ? `External Libraries: removed ${removed} read-only glob(s) from your user settings.`
          : 'External Libraries: no read-only globs had been written.',
      );
    }),
  );

  /* ------------------------------------------------- active editor tracking */

  let debounce: NodeJS.Timeout | undefined;
  let lastHandled: string | undefined;

  const handleActiveEditor = (editor: vscode.TextEditor | undefined) => {
    if (debounce) {
      clearTimeout(debounce);
      debounce = undefined;
    }
    if (!editor || editor.document.uri.scheme !== 'file') {
      return;
    }
    const key = editor.document.uri.toString();
    if (key === lastHandled) {
      return;
    }
    debounce = setTimeout(() => {
      debounce = undefined;
      lastHandled = key;
      void onExternalEditor(view, provider, readonly, editor, log);
    }, REVEAL_DEBOUNCE_MS);
  };

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(handleActiveEditor),
    new vscode.Disposable(() => {
      if (debounce) {
        clearTimeout(debounce);
      }
    }),
  );

  // Kick off the first probe and handle whatever is already open.
  void provider.refresh().then(() => handleActiveEditor(vscode.window.activeTextEditor));
}

export function deactivate(): void {
  /* nothing to tear down beyond the disposables */
}

async function onExternalEditor(
  view: vscode.TreeView<Node>,
  provider: ExternalLibrariesProvider,
  readonly: ReadonlyManager,
  editor: vscode.TextEditor,
  log: vscode.OutputChannel,
): Promise<void> {
  const fsPath = editor.document.uri.fsPath;
  let external = false;
  try {
    external = await provider.isExternalPath(fsPath);
  } catch (err) {
    log.appendLine(`active editor check failed for ${fsPath}: ${errText(err)}`);
    return;
  }
  if (!external) {
    return;
  }
  await readonly.apply(editor);
  await revealEditor(view, provider, editor, false);
}

async function revealEditor(
  view: vscode.TreeView<Node>,
  provider: ExternalLibrariesProvider,
  editor: vscode.TextEditor,
  focusView: boolean,
): Promise<boolean> {
  const node = await provider.findNodeForFile(editor.document.uri.fsPath);
  if (!node) {
    return false;
  }
  try {
    // focus:false is a hard requirement — the cursor must stay in the editor.
    await view.reveal(node, { select: true, focus: focusView, expand: false });
    return true;
  } catch {
    // reveal() throws when the element cannot be reached; never surface it.
    return false;
  }
}

function nodePath(node: Node | undefined): string | undefined {
  if (!node) {
    return undefined;
  }
  if (node.kind === 'root') {
    return node.entry.fsPath;
  }
  if (node.kind === 'fs') {
    return node.fsPath;
  }
  return undefined;
}

function setGroupModeContext(mode: GroupMode): Thenable<unknown> {
  return vscode.commands.executeCommand('setContext', MODE_CONTEXT_KEY, mode);
}
