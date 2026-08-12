/**
 * Lazy TreeDataProvider for the External Libraries view.
 *
 * Node identity matters more than anything else here: `reveal()` matches the
 * element returned by `getParent()` against what `getChildren()` returned, so
 * every node is cached by id and handed back as the same object.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import {
  GROUP_ICONS,
  GROUP_LABELS,
  GROUP_ORDER,
  GroupId,
  PathEntry,
  Snapshot,
  buildSnapshot,
  errText,
  isUnder,
  pathKey,
} from './resolver';

export type GroupMode = 'rez' | 'path';

export interface GroupNode {
  kind: 'group';
  id: string;
  group: GroupId;
  entries: PathEntry[];
}

export interface RootNode {
  kind: 'root';
  id: string;
  entry: PathEntry;
}

export interface FsNode {
  kind: 'fs';
  id: string;
  fsPath: string;
  isDirectory: boolean;
  /** Id of the owning root node, so getParent can stop at the right place. */
  rootId: string;
  rootPath: string;
}

export interface MessageNode {
  kind: 'message';
  id: string;
  label: string;
  detail?: string;
  icon?: string;
}

export type Node = GroupNode | RootNode | FsNode | MessageNode;

const IGNORED_NAMES = new Set(['__pycache__']);

export class ExternalLibrariesProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly _onDidChangeSnapshot = new vscode.EventEmitter<Snapshot | undefined>();
  /** Fired after every refresh so the view can update its message. */
  readonly onDidChangeSnapshot = this._onDidChangeSnapshot.event;

  private snapshot: Snapshot | undefined;
  private loading: Promise<void> | undefined;
  private mode: GroupMode;

  private groupNodes: GroupNode[] = [];
  private rootNodes: RootNode[] = [];
  private readonly nodes = new Map<string, Node>();
  private readonly dirCache = new Map<string, Promise<FsNode[]>>();

  constructor(mode: GroupMode, private readonly log: vscode.OutputChannel) {
    this.mode = mode;
  }

  get groupMode(): GroupMode {
    return this.mode;
  }

  get current(): Snapshot | undefined {
    return this.snapshot;
  }

  setGroupMode(mode: GroupMode): void {
    if (this.mode === mode) {
      return;
    }
    this.mode = mode;
    this.rebuildRoots();
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Re-probes the interpreter and rebuilds everything. */
  refresh(): Promise<void> {
    this.snapshot = undefined;
    this.dirCache.clear();
    this.nodes.clear();
    this.loading = undefined;
    this._onDidChangeTreeData.fire(undefined);
    return this.ensureLoaded();
  }

  private ensureLoaded(): Promise<void> {
    if (!this.loading) {
      this.loading = this.load();
    }
    return this.loading;
  }

  private async load(): Promise<void> {
    const started = Date.now();
    try {
      this.snapshot = await buildSnapshot();
    } catch (err) {
      this.snapshot = {
        interpreterSource: 'none',
        entries: [],
        rezPackages: [],
        error: errText(err),
        log: [`unexpected failure: ${errText(err)}`],
      };
    }
    this.log.appendLine(`--- refresh (${Date.now() - started} ms) ---`);
    for (const line of this.snapshot.log) {
      this.log.appendLine(line);
    }
    if (this.snapshot.error) {
      this.log.appendLine(`ERROR: ${this.snapshot.error}`);
    }
    this.rebuildRoots();
    this._onDidChangeSnapshot.fire(this.snapshot);
  }

  private rebuildRoots(): void {
    this.nodes.clear();
    this.dirCache.clear();
    this.groupNodes = [];
    this.rootNodes = [];

    const entries = this.snapshot?.entries ?? [];
    if (this.mode === 'path') {
      // Raw resolution order: no grouping, no reordering, no de-duplication.
      this.rootNodes = entries.map((entry) => this.rootNode(entry));
      return;
    }

    // Grouped mode: de-duplicate repeated sys.path entries, first one wins.
    const byGroup = new Map<GroupId, PathEntry[]>();
    const seen = new Set<string>();
    for (const entry of entries) {
      const key = pathKey(entry.fsPath);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const list = byGroup.get(entry.group) ?? [];
      list.push(entry);
      byGroup.set(entry.group, list);
    }

    for (const group of GROUP_ORDER) {
      const list = byGroup.get(group);
      if (!list || list.length === 0) {
        continue;
      }
      if (group === 'rez') {
        list.sort((a, b) => rezLabel(a).localeCompare(rezLabel(b)));
      }
      const node: GroupNode = { kind: 'group', id: `group:${group}`, group, entries: list };
      this.nodes.set(node.id, node);
      this.groupNodes.push(node);
      for (const entry of list) {
        this.rootNode(entry);
      }
    }
  }

  private rootNode(entry: PathEntry): RootNode {
    const id = `root:${entry.index}`;
    const existing = this.nodes.get(id);
    if (existing && existing.kind === 'root') {
      return existing;
    }
    const node: RootNode = { kind: 'root', id, entry };
    this.nodes.set(id, node);
    return node;
  }

  private fsNode(rootId: string, rootPath: string, fsPath: string, isDirectory: boolean): FsNode {
    const id = `fs:${rootId}:${pathKey(fsPath)}`;
    const existing = this.nodes.get(id);
    if (existing && existing.kind === 'fs') {
      return existing;
    }
    const node: FsNode = { kind: 'fs', id, fsPath, isDirectory, rootId, rootPath };
    this.nodes.set(id, node);
    return node;
  }

  /* ------------------------------------------------------------- children */

  async getChildren(element?: Node): Promise<Node[]> {
    if (!element) {
      await this.ensureLoaded();
      const snapshot = this.snapshot;
      if (snapshot?.error) {
        return [
          {
            kind: 'message',
            id: 'message:error',
            label: snapshot.error,
            detail: 'Run "External Libraries: Show Diagnostics Log" for details.',
            icon: 'error',
          },
        ];
      }
      if (!snapshot || snapshot.entries.length === 0) {
        return [
          {
            kind: 'message',
            id: 'message:empty',
            label: 'No sys.path entries found.',
            icon: 'info',
          },
        ];
      }
      return this.mode === 'rez' ? this.groupNodes : this.rootNodes;
    }

    switch (element.kind) {
      case 'group':
        return element.entries.map((entry) => this.rootNode(entry));
      case 'root':
        if (!element.entry.exists || element.entry.isArchive) {
          return [];
        }
        return this.readDirectory(element.id, element.entry.fsPath, element.entry.fsPath);
      case 'fs':
        if (!element.isDirectory) {
          return [];
        }
        return this.readDirectory(element.rootId, element.rootPath, element.fsPath);
      case 'message':
        return [];
    }
  }

  private readDirectory(rootId: string, rootPath: string, dir: string): Promise<FsNode[]> {
    const key = `${rootId}:${pathKey(dir)}`;
    let pending = this.dirCache.get(key);
    if (!pending) {
      pending = this.listDirectory(rootId, rootPath, dir);
      this.dirCache.set(key, pending);
    }
    return pending;
  }

  private async listDirectory(rootId: string, rootPath: string, dir: string): Promise<FsNode[]> {
    let raw: [string, vscode.FileType][];
    try {
      raw = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
    } catch (err) {
      this.log.appendLine(`readDirectory failed for ${dir}: ${errText(err)}`);
      return [];
    }

    const nodes: FsNode[] = [];
    for (const [name, type] of raw) {
      if (IGNORED_NAMES.has(name) || name.endsWith('.pyc') || name.endsWith('.pyo')) {
        continue;
      }
      const isDirectory = (type & vscode.FileType.Directory) !== 0;
      nodes.push(this.fsNode(rootId, rootPath, path.join(dir, name), isDirectory));
    }

    nodes.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return path.basename(a.fsPath).localeCompare(path.basename(b.fsPath));
    });
    return nodes;
  }

  /* --------------------------------------------------------------- parent */

  getParent(element: Node): Node | undefined {
    switch (element.kind) {
      case 'group':
      case 'message':
        return undefined;
      case 'root':
        if (this.mode === 'path') {
          return undefined;
        }
        return this.nodes.get(`group:${element.entry.group}`);
      case 'fs': {
        const parentDir = path.dirname(element.fsPath);
        if (pathKey(parentDir) === pathKey(element.rootPath) || parentDir === element.fsPath) {
          return this.nodes.get(element.rootId);
        }
        return this.fsNode(element.rootId, element.rootPath, parentDir, true);
      }
    }
  }

  /* --------------------------------------------------------------- lookup */

  /**
   * Finds the node for a file on disk, materialising the ancestor chain so
   * `reveal()` can walk it. Returns undefined when the file is not under any
   * root of the tree.
   */
  async findNodeForFile(fsPath: string): Promise<Node | undefined> {
    await this.ensureLoaded();
    const roots = this.mode === 'rez' ? this.collectGroupedRoots() : this.rootNodes;

    let best: RootNode | undefined;
    for (const root of roots) {
      if (!root.entry.exists || root.entry.isArchive) {
        continue;
      }
      if (!isUnder(fsPath, root.entry.fsPath)) {
        continue;
      }
      // Deepest matching root wins: a nested package root beats its parent.
      if (!best || root.entry.fsPath.length > best.entry.fsPath.length) {
        best = root;
      }
    }
    if (!best) {
      return undefined;
    }
    if (pathKey(fsPath) === pathKey(best.entry.fsPath)) {
      return best;
    }
    return this.fsNode(best.id, best.entry.fsPath, fsPath, false);
  }

  private collectGroupedRoots(): RootNode[] {
    const roots: RootNode[] = [];
    for (const group of this.groupNodes) {
      for (const entry of group.entries) {
        roots.push(this.rootNode(entry));
      }
    }
    return roots;
  }

  /** True when the path lives under one of the tree's roots. */
  async isExternalPath(fsPath: string): Promise<boolean> {
    await this.ensureLoaded();
    const inWorkspace = (vscode.workspace.workspaceFolders ?? []).some((folder) =>
      isUnder(fsPath, folder.uri.fsPath),
    );
    if (inWorkspace) {
      return false;
    }
    return (this.snapshot?.entries ?? []).some(
      (entry) => entry.exists && !entry.isArchive && isUnder(fsPath, entry.fsPath),
    );
  }

  /* ------------------------------------------------------------ tree item */

  getTreeItem(element: Node): vscode.TreeItem {
    switch (element.kind) {
      case 'message':
        return this.messageItem(element);
      case 'group':
        return this.groupItem(element);
      case 'root':
        return this.rootItem(element);
      case 'fs':
        return this.fsItem(element);
    }
  }

  private messageItem(node: MessageNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.id = this.itemId(node);
    item.description = node.detail;
    item.tooltip = node.detail ?? node.label;
    item.iconPath = new vscode.ThemeIcon(node.icon ?? 'info');
    item.contextValue = 'externalLibraries.message';
    return item;
  }

  private groupItem(node: GroupNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      GROUP_LABELS[node.group],
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = this.itemId(node);
    item.description = String(node.entries.length);
    item.iconPath = new vscode.ThemeIcon(GROUP_ICONS[node.group]);
    item.contextValue = 'externalLibraries.group';
    return item;
  }

  private rootItem(node: RootNode): vscode.TreeItem {
    const entry = node.entry;
    const expandable = entry.exists && !entry.isArchive;
    const item = new vscode.TreeItem(
      vscode.Uri.file(entry.fsPath),
      expandable
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = this.itemId(node);

    if (this.mode === 'path') {
      const order = String(entry.index).padStart(2, '0');
      item.label = `${order}  ${displayName(entry)}`;
      item.description = entry.fsPath;
    } else if (entry.rez) {
      item.label = rezLabel(entry);
      item.description = entry.fsPath;
    } else {
      item.label = displayName(entry);
      item.description = path.dirname(entry.fsPath);
    }

    if (!entry.exists) {
      item.iconPath = new vscode.ThemeIcon(
        'warning',
        new vscode.ThemeColor('list.warningForeground'),
      );
      item.contextValue = 'externalLibraries.missing';
    } else {
      item.contextValue = 'externalLibraries.root';
      if (entry.isArchive) {
        item.iconPath = new vscode.ThemeIcon('file-zip');
      }
    }

    item.tooltip = rootTooltip(entry);
    return item;
  }

  private fsItem(node: FsNode): vscode.TreeItem {
    const uri = vscode.Uri.file(node.fsPath);
    const item = new vscode.TreeItem(
      uri,
      node.isDirectory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = this.itemId(node);
    item.contextValue = node.isDirectory ? 'externalLibraries.dir' : 'externalLibraries.file';
    if (!node.isDirectory) {
      item.command = {
        command: 'vscode.open',
        title: 'Open',
        arguments: [uri],
      };
    }
    return item;
  }

  /**
   * The mode is part of the item id so expansion state does not leak between
   * the two groupings.
   */
  private itemId(node: Node): string {
    return `${this.mode}:${node.id}`;
  }
}

function displayName(entry: PathEntry): string {
  const base = path.basename(entry.fsPath);
  return base || entry.fsPath;
}

function rezLabel(entry: PathEntry): string {
  if (!entry.rez) {
    return displayName(entry);
  }
  return entry.rez.version ? `${entry.rez.name} ${entry.rez.version}` : entry.rez.name;
}

function rootTooltip(entry: PathEntry): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**sys.path[${entry.index}]**\n\n`);
  md.appendMarkdown(`\`${entry.fsPath}\`\n\n`);
  if (entry.rez) {
    md.appendMarkdown(`Rez package: \`${entry.rez.name}\``);
    if (entry.rez.version) {
      md.appendMarkdown(` \`${entry.rez.version}\``);
    }
    md.appendMarkdown(`\n\nPackage root: \`${entry.rez.root}\`\n\n`);
  }
  if (entry.pthSource) {
    md.appendMarkdown(`Injected by: \`${entry.pthSource}\`\n\n`);
  }
  if (!entry.exists) {
    md.appendMarkdown(`⚠️ This path is on \`sys.path\` but does not exist on disk.\n\n`);
  }
  if (entry.isArchive) {
    md.appendMarkdown(`Archive import — listed, but not expandable.\n\n`);
  }
  if (entry.note) {
    md.appendMarkdown(`_${entry.note}_\n\n`);
  }
  md.appendMarkdown(`Group: ${GROUP_LABELS[entry.group]}`);
  return md;
}
