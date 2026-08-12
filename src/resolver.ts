/**
 * Resolver: figures out which interpreter is active, asks it for its real
 * sys.path (inheriting the Rez resolve from process.env), parses the REZ_*
 * variables and classifies every sys.path entry into a display group.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export type GroupId =
  | 'rez'
  | 'editable'
  | 'site'
  | 'stdlib'
  | 'workspace'
  | 'other'
  | 'unresolved';

/** Display order of the groups in `rez` mode. */
export const GROUP_ORDER: GroupId[] = [
  'rez',
  'editable',
  'site',
  'stdlib',
  'workspace',
  'other',
  'unresolved',
];

export const GROUP_LABELS: Record<GroupId, string> = {
  rez: 'Rez Packages',
  editable: 'Editable Installs',
  site: 'Site Packages',
  stdlib: 'Standard Library',
  workspace: 'Workspace',
  other: 'Other sys.path Entries',
  unresolved: 'Unresolved (not on disk)',
};

export const GROUP_ICONS: Record<GroupId, string> = {
  rez: 'package',
  editable: 'edit',
  site: 'library',
  stdlib: 'symbol-namespace',
  workspace: 'root-folder',
  other: 'folder-library',
  unresolved: 'warning',
};

export interface RezPackage {
  name: string;
  version: string;
  root: string;
}

export interface PathEntry {
  /** Normalised absolute path (the empty sys.path entry is resolved to cwd). */
  fsPath: string;
  /** Entry exactly as Python reported it. */
  raw: string;
  /** Position in sys.path — the order Python actually searches. */
  index: number;
  group: GroupId;
  exists: boolean;
  /** True for .zip / .egg archives: listed, but not expandable. */
  isArchive: boolean;
  rez?: RezPackage;
  /** The .pth file that injected this directory, when applicable. */
  pthSource?: string;
  /** Extra note shown in the tooltip (cwd, duplicate, ...). */
  note?: string;
}

export interface PythonProbe {
  executable: string;
  version: string;
  prefix: string;
  base_prefix: string;
  sys_path: string[];
  stdlib: string[];
  site_packages: string[];
  pth_dirs: { dir: string; source: string }[];
  cwd: string;
}

export interface Snapshot {
  interpreter?: string;
  interpreterSource: string;
  pythonVersion?: string;
  entries: PathEntry[];
  rezPackages: RezPackage[];
  rezContext?: string;
  error?: string;
  /** Human readable lines for the diagnostics log. */
  log: string[];
}

/* ------------------------------------------------------------------ paths */

const isWindows = process.platform === 'win32';

/** Comparable key for a path: normalised, and case-folded on Windows. */
export function pathKey(p: string): string {
  let n = path.normalize(p);
  if (n.length > 1 && (n.endsWith(path.sep) || n.endsWith('/'))) {
    n = n.slice(0, -1);
  }
  return isWindows ? n.toLowerCase().replace(/\//g, '\\') : n;
}

/** True when `child` is `parent` itself or lives underneath it. */
export function isUnder(child: string, parent: string): boolean {
  const c = pathKey(child);
  const p = pathKey(parent);
  if (c === p) {
    return true;
  }
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/* -------------------------------------------------------------- interpreter */

interface InterpreterPick {
  executable?: string;
  source: string;
}

/**
 * Resolve the active interpreter through the Python extension API, falling
 * back to the envs extension, then the user setting, then the PATH.
 * Every step is defensive: a missing Python extension must degrade, not throw.
 */
export async function findInterpreter(log: string[]): Promise<InterpreterPick> {
  const fromPythonExt = await tryPythonExtension(log);
  if (fromPythonExt) {
    return { executable: fromPythonExt, source: 'ms-python.python' };
  }

  const fromEnvsExt = await tryEnvsExtension(log);
  if (fromEnvsExt) {
    return { executable: fromEnvsExt, source: 'ms-python.vscode-python-envs' };
  }

  const configured = vscode.workspace
    .getConfiguration('python')
    .get<string>('defaultInterpreterPath');
  if (configured && configured.trim()) {
    log.push(`interpreter: python.defaultInterpreterPath = ${configured}`);
    return { executable: configured.trim(), source: 'python.defaultInterpreterPath' };
  }

  const onPath = isWindows ? 'python.exe' : 'python3';
  log.push(`interpreter: falling back to "${onPath}" on PATH`);
  return { executable: onPath, source: 'PATH' };
}

async function tryPythonExtension(log: string[]): Promise<string | undefined> {
  try {
    const ext = vscode.extensions.getExtension('ms-python.python');
    if (!ext) {
      log.push('interpreter: ms-python.python is not installed');
      return undefined;
    }
    const api: any = ext.isActive ? ext.exports : await ext.activate();
    const active = api?.environments?.getActiveEnvironmentPath?.();
    if (!active) {
      return undefined;
    }
    const resolved = await api.environments.resolveEnvironment(active);
    const exe: string | undefined =
      resolved?.executable?.uri?.fsPath ?? (typeof active.path === 'string' ? active.path : undefined);
    if (exe) {
      log.push(`interpreter: ms-python.python -> ${exe}`);
    }
    return exe;
  } catch (err) {
    log.push(`interpreter: ms-python.python failed: ${errText(err)}`);
    return undefined;
  }
}

async function tryEnvsExtension(log: string[]): Promise<string | undefined> {
  try {
    const ext = vscode.extensions.getExtension('ms-python.vscode-python-envs');
    if (!ext) {
      return undefined;
    }
    const api: any = ext.isActive ? ext.exports : await ext.activate();
    const env = await api?.getEnvironment?.(undefined);
    const exe: string | undefined =
      env?.execInfo?.run?.executable ?? env?.environmentPath?.fsPath ?? env?.executable;
    if (exe) {
      log.push(`interpreter: ms-python.vscode-python-envs -> ${exe}`);
    }
    return exe;
  } catch (err) {
    log.push(`interpreter: ms-python.vscode-python-envs failed: ${errText(err)}`);
    return undefined;
  }
}

/**
 * Called when the interpreter selection changes so the tree can refresh.
 * Returns a disposable; never throws when the Python extension is absent.
 */
export function onDidChangeInterpreter(handler: () => void): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];
  try {
    const ext = vscode.extensions.getExtension('ms-python.python');
    const api: any = ext?.exports;
    const evt = api?.environments?.onDidChangeActiveEnvironmentPath;
    if (typeof evt === 'function') {
      disposables.push(evt(() => handler()));
    }
  } catch {
    /* the Python extension is optional — degrade silently */
  }
  return vscode.Disposable.from(...disposables);
}

/* -------------------------------------------------------------------- probe */

const MARKER = '<<<EXTLIB>>>';

/**
 * Printed by the interpreter itself — never guessed on our side. The JSON is
 * prefixed with a marker because any Rez package is free to print noise on
 * import, so we take everything after the *last* marker occurrence.
 */
const PROBE_SCRIPT = `
import json, os, site, sys, sysconfig

def _unique(items):
    out = []
    for it in items:
        if it and it not in out:
            out.append(it)
    return out

def _site_dirs():
    dirs = []
    try:
        dirs.extend(site.getsitepackages())
    except Exception:
        pass
    try:
        usersite = site.getusersitepackages()
        if isinstance(usersite, str):
            dirs.append(usersite)
        else:
            dirs.extend(usersite)
    except Exception:
        pass
    try:
        paths = sysconfig.get_paths()
        for key in ('purelib', 'platlib'):
            if paths.get(key):
                dirs.append(paths[key])
    except Exception:
        pass
    return _unique([os.path.normpath(d) for d in dirs])

def _pth_dirs(site_dirs):
    found = []
    for d in site_dirs:
        try:
            names = sorted(os.listdir(d))
        except Exception:
            continue
        for name in names:
            if not name.endswith('.pth'):
                continue
            source = os.path.join(d, name)
            try:
                with open(source, 'r', encoding='utf-8', errors='replace') as fh:
                    for line in fh:
                        line = line.strip()
                        if not line or line.startswith('#'):
                            continue
                        if line.startswith('import ') or line.startswith('import\\t'):
                            continue
                        target = line if os.path.isabs(line) else os.path.join(d, line)
                        found.append({'dir': os.path.normpath(target), 'source': source})
            except Exception:
                continue
    return found

paths = {}
try:
    paths = sysconfig.get_paths()
except Exception:
    paths = {}

stdlib = _unique([paths.get('stdlib'), paths.get('platstdlib')])
site_dirs = _site_dirs()

data = {
    'executable': sys.executable,
    'version': sys.version.split()[0],
    'prefix': sys.prefix,
    'base_prefix': getattr(sys, 'base_prefix', sys.prefix),
    'sys_path': list(sys.path),
    'stdlib': stdlib,
    'site_packages': site_dirs,
    'pth_dirs': _pth_dirs(site_dirs),
    'cwd': os.getcwd(),
}
sys.stdout.write('${MARKER}' + json.dumps(data))
sys.stdout.flush()
`;

export async function probePython(
  executable: string,
  cwd: string | undefined,
  log: string[],
): Promise<PythonProbe> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      executable,
      // No -I / -E / -S here: the whole point is to inherit PYTHONPATH and the
      // site configuration of the Rez resolve exactly as Python would see it.
      ['-c', PROBE_SCRIPT],
      {
        cwd,
        env: process.env, // inherits PYTHONPATH + REZ_* from the rez env launch
        timeout: 60_000,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      },
      (err, out, errOut) => {
        if (err && !out.includes(MARKER)) {
          reject(new Error(`${errText(err)}${errOut ? `\n${errOut.trim()}` : ''}`));
          return;
        }
        if (errOut && errOut.trim()) {
          log.push(`probe stderr: ${errOut.trim().split('\n').slice(-5).join(' | ')}`);
        }
        resolve(out);
      },
    );
  });

  const at = stdout.lastIndexOf(MARKER);
  if (at < 0) {
    throw new Error(`interpreter produced no ${MARKER} payload`);
  }
  return JSON.parse(stdout.slice(at + MARKER.length)) as PythonProbe;
}

/* ---------------------------------------------------------------------- rez */

/**
 * Rez exports REZ_<PACKAGE>_ROOT / _VERSION with the name upper-cased and
 * dashes turned into underscores, which is lossy. REZ_USED_RESOLVE carries the
 * canonical `name-version` tokens, so we use it to fix the spelling back up.
 */
export function parseRezPackages(env: NodeJS.ProcessEnv, log: string[]): RezPackage[] {
  const canonical = new Map<string, string>(); // normalised name -> real name
  const resolve = env.REZ_USED_RESOLVE ?? '';
  for (const token of resolve.split(/\s+/)) {
    if (!token) {
      continue;
    }
    // `name-1.2.3`, and names may themselves contain dashes: split at the last
    // dash that starts a version-looking chunk.
    const m = /^(.*?)-([0-9][^-]*(?:[.-][^-]*)*)$/.exec(token);
    const name = m ? m[1] : token;
    canonical.set(normaliseRezName(name), name);
  }

  const packages: RezPackage[] = [];
  for (const [key, value] of Object.entries(env)) {
    const m = /^REZ_(.+)_ROOT$/.exec(key);
    if (!m || !value) {
      continue;
    }
    const normalised = m[1];
    // REZ_USED_* and REZ_CONTEXT_* are context metadata, not packages.
    if (normalised === 'USED' || normalised.startsWith('USED_') || normalised.startsWith('CONTEXT_')) {
      continue;
    }
    const name = canonical.get(normalised) ?? normalised.toLowerCase().replace(/_/g, '-');
    const version = env[`REZ_${normalised}_VERSION`] ?? '';
    packages.push({ name, version, root: path.normalize(value) });
  }

  // Longest root first so a nested package root wins over its parent.
  packages.sort((a, b) => pathKey(b.root).length - pathKey(a.root).length);
  log.push(`rez: ${packages.length} package root(s) from the environment`);
  return packages;
}

function normaliseRezName(name: string): string {
  return name.toUpperCase().replace(/-/g, '_');
}

/* ----------------------------------------------------------- classification */

export async function buildSnapshot(): Promise<Snapshot> {
  const log: string[] = [];
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  const cwd = workspaceFolders[0]?.uri.fsPath;
  const rezPackages = parseRezPackages(process.env, log);

  const pick = await findInterpreter(log);
  if (!pick.executable) {
    return {
      interpreterSource: pick.source,
      entries: [],
      rezPackages,
      rezContext: process.env.REZ_USED_RESOLVE,
      error: 'No Python interpreter could be determined.',
      log,
    };
  }

  let probe: PythonProbe;
  try {
    probe = await probePython(pick.executable, cwd, log);
  } catch (err) {
    return {
      interpreter: pick.executable,
      interpreterSource: pick.source,
      entries: [],
      rezPackages,
      rezContext: process.env.REZ_USED_RESOLVE,
      error: `Could not query ${pick.executable}: ${errText(err)}`,
      log,
    };
  }

  log.push(`probe: python ${probe.version} at ${probe.executable}`);
  log.push(`probe: ${probe.sys_path.length} sys.path entries, ${probe.pth_dirs.length} .pth injections`);

  const pthByPath = new Map<string, string>();
  for (const p of probe.pth_dirs) {
    pthByPath.set(pathKey(p.dir), p.source);
  }
  const siteKeys = new Set(probe.site_packages.map(pathKey));
  const stdlibDirs = probe.stdlib.filter(Boolean);

  const entries: PathEntry[] = [];
  const seen = new Map<string, number>();

  for (let index = 0; index < probe.sys_path.length; index++) {
    const raw = probe.sys_path[index];
    const resolved = raw === '' ? probe.cwd : path.normalize(raw);
    const key = pathKey(resolved);
    const stat = await statSafe(resolved);
    const isArchive = /\.(zip|egg)$/i.test(resolved);

    const entry: PathEntry = {
      fsPath: resolved,
      raw,
      index,
      exists: stat !== undefined,
      isArchive: isArchive || (stat !== undefined && !stat.isDirectory()),
      group: 'other',
      note: raw === '' ? 'empty sys.path entry — resolved to the process working directory' : undefined,
    };

    const rez = rezPackages.find((p) => isUnder(resolved, p.root));
    if (rez) {
      entry.rez = rez;
    }
    const pthSource = pthByPath.get(key);
    if (pthSource) {
      entry.pthSource = pthSource;
    }

    if (!entry.exists && isStdlibZip(resolved)) {
      // Every CPython puts `pythonXY.zip` on sys.path and most installs do not
      // ship it. Reporting that as "unresolved" every single time would train
      // people to ignore the one section that actually matters.
      entry.group = 'stdlib';
      entry.note = 'stdlib archive not present on disk (normal for most CPython installs)';
    } else if (!entry.exists) {
      entry.group = 'unresolved';
    } else if (rez) {
      entry.group = 'rez';
    } else if (siteKeys.has(key)) {
      // A real site dir wins over a .pth reference to it; genuine editable
      // installs point at a source tree that is never itself a site dir.
      entry.group = 'site';
    } else if (pthSource) {
      entry.group = 'editable';
    } else if (entry.isArchive || stdlibDirs.some((d) => isUnder(resolved, d))) {
      entry.group = 'stdlib';
    } else if (workspaceFolders.some((f) => isUnder(resolved, f.uri.fsPath))) {
      entry.group = 'workspace';
    }

    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, index);
    } else {
      entry.note = `duplicate of sys.path[${first}]`;
    }

    entries.push(entry);
  }

  const counts = new Map<GroupId, number>();
  for (const e of entries) {
    counts.set(e.group, (counts.get(e.group) ?? 0) + 1);
  }
  for (const g of GROUP_ORDER) {
    if (counts.get(g)) {
      log.push(`  ${GROUP_LABELS[g]}: ${counts.get(g)}`);
    }
  }

  return {
    interpreter: probe.executable || pick.executable,
    interpreterSource: pick.source,
    pythonVersion: probe.version,
    entries,
    rezPackages,
    rezContext: process.env.REZ_USED_RESOLVE,
    log,
  };
}

/** Matches the `python313.zip` entry CPython always adds to sys.path. */
function isStdlibZip(p: string): boolean {
  return /^python\d+\.zip$/i.test(path.basename(p));
}

async function statSafe(p: string): Promise<fs.Stats | undefined> {
  try {
    return await fs.promises.stat(p);
  } catch {
    return undefined;
  }
}

export function errText(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
