/**
 * Read-only strategy.
 *
 * Preferred: `workbench.action.files.setActiveEditorReadonlyInSession` — per
 * editor, session-scoped, writes nothing to any settings.json. Its existence is
 * probed at startup because it is not guaranteed to exist in every Cursor build.
 *
 * Fallback: `files.readonlyInclude` globs written to the *global* (user) target,
 * never the workspace one, so a versioned `.vscode/settings.json` stays clean.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { errText } from './resolver';

const SESSION_COMMAND = 'workbench.action.files.setActiveEditorReadonlyInSession';
const CONFIG_SECTION = 'files';
const CONFIG_KEY = 'readonlyInclude';
const STATE_KEY = 'externalLibraries.writtenReadonlyGlobs';

export type ReadonlyStrategy = 'session' | 'config' | 'unavailable';

export class ReadonlyManager {
  private strategy: ReadonlyStrategy = 'unavailable';
  private readonly appliedDocuments = new Set<string>();
  private readonly appliedGlobs = new Set<string>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.OutputChannel,
  ) {
    for (const glob of context.globalState.get<string[]>(STATE_KEY, [])) {
      this.appliedGlobs.add(glob);
    }
  }

  get activeStrategy(): ReadonlyStrategy {
    return this.strategy;
  }

  /** Detects which mechanism this editor build actually supports. */
  async probe(): Promise<ReadonlyStrategy> {
    try {
      const commands = await vscode.commands.getCommands(true);
      if (commands.includes(SESSION_COMMAND)) {
        this.strategy = 'session';
        this.log.appendLine(`readonly: using session command (${SESSION_COMMAND})`);
        return this.strategy;
      }
      this.log.appendLine(
        `readonly: ${SESSION_COMMAND} is not available in this build, falling back to ` +
          `"${CONFIG_SECTION}.${CONFIG_KEY}" globs in user settings`,
      );
    } catch (err) {
      this.log.appendLine(`readonly: command probe failed: ${errText(err)}`);
    }
    this.strategy = 'config';
    return this.strategy;
  }

  /**
   * Marks the given editor's document read-only. Must be called while that
   * editor is the active one — the session command targets the active editor.
   */
  async apply(editor: vscode.TextEditor): Promise<void> {
    const uri = editor.document.uri;
    if (uri.scheme !== 'file') {
      return;
    }
    const key = uri.toString();
    if (this.appliedDocuments.has(key)) {
      return;
    }

    if (this.strategy === 'session') {
      if (vscode.window.activeTextEditor !== editor) {
        return; // the command applies to the active editor only
      }
      try {
        await vscode.commands.executeCommand(SESSION_COMMAND);
        this.appliedDocuments.add(key);
        return;
      } catch (err) {
        this.log.appendLine(`readonly: session command failed, falling back: ${errText(err)}`);
        this.strategy = 'config';
      }
    }

    if (this.strategy === 'config') {
      await this.applyGlob(uri.fsPath);
      this.appliedDocuments.add(key);
    }
  }

  /**
   * Applies the glob to the containing directory rather than the single file,
   * otherwise the setting grows without bound as you jump around.
   */
  private async applyGlob(fsPath: string): Promise<void> {
    const glob = `${toGlobPath(path.dirname(fsPath))}/**`;
    if (this.appliedGlobs.has(glob)) {
      return;
    }

    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const inspected = config.inspect<Record<string, boolean>>(CONFIG_KEY);
    const current = { ...(inspected?.globalValue ?? {}) };
    if (current[glob] === true) {
      this.appliedGlobs.add(glob);
      await this.rememberGlobs();
      return;
    }

    current[glob] = true;
    try {
      await config.update(CONFIG_KEY, current, vscode.ConfigurationTarget.Global);
      this.appliedGlobs.add(glob);
      await this.rememberGlobs();
      this.log.appendLine(`readonly: added user-settings glob ${glob}`);
    } catch (err) {
      this.log.appendLine(`readonly: could not update ${CONFIG_KEY}: ${errText(err)}`);
    }
  }

  private rememberGlobs(): Thenable<void> {
    return this.context.globalState.update(STATE_KEY, [...this.appliedGlobs]);
  }

  /** Removes every glob this extension wrote into the user settings. */
  async clearWrittenGlobs(): Promise<number> {
    const globs = [...this.appliedGlobs];
    if (globs.length === 0) {
      return 0;
    }
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const inspected = config.inspect<Record<string, boolean>>(CONFIG_KEY);
    const current = { ...(inspected?.globalValue ?? {}) };
    let removed = 0;
    for (const glob of globs) {
      if (glob in current) {
        delete current[glob];
        removed++;
      }
    }
    const next = Object.keys(current).length > 0 ? current : undefined;
    await config.update(CONFIG_KEY, next, vscode.ConfigurationTarget.Global);
    this.appliedGlobs.clear();
    this.appliedDocuments.clear();
    await this.rememberGlobs();
    this.log.appendLine(`readonly: removed ${removed} glob(s) from user settings`);
    return removed;
  }
}

/** `files.readonlyInclude` globs use forward slashes on every platform. */
function toGlobPath(fsPath: string): string {
  return fsPath.replace(/\\/g, '/').replace(/\/+$/, '');
}
