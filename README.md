# External Libraries

A PyCharm-style **External Libraries** node for VS Code / Cursor.

It shows, read-only, every folder Python is actually resolving on `sys.path` —
all of it, not just `site-packages` — and it **auto-reveals the file you just
jumped to** with Go To Definition, without moving your cursor out of the editor.

Built for a Rez pipeline, where `PYTHONPATH` routinely carries 30+ entries and
"where on earth did this file come from?" is the daily question.

---

## What it does

- **Lists the real `sys.path`.** The extension does not guess: it launches the
  active interpreter with `env: process.env`, so it inherits the Rez resolve the
  editor was launched from, and asks Python to print its own `sys.path`,
  `sysconfig` paths, site dirs and `.pth` injections.
- **Groups the entries** (default `rez` mode):

  | Group | What lands here |
  |---|---|
  | `Rez Packages` | Under some `REZ_<PKG>_ROOT`, labelled `name version` |
  | `Editable Installs` | Injected by a `.pth` file inside a site dir |
  | `Site Packages` | Exactly a `site.getsitepackages()` / `purelib` / `platlib` |
  | `Standard Library` | Under `sysconfig` `stdlib` / `platstdlib`, or a `.zip` / `.egg` |
  | `Workspace` | Under an open workspace folder |
  | `Other sys.path Entries` | Everything else |
  | `Unresolved (not on disk)` | On `sys.path` but missing — deliberately **not** hidden |

- **Toggles to raw resolution order** (`path` mode): a flat, numbered
  `00, 01, 02…` list, in the exact order Python will search. The toggle lives in
  the view title bar; the choice is remembered in `globalState`, not in your
  settings.
- **Auto-reveals** the active editor's file when it is external, expanding the
  ancestor chain and selecting it — `focus: false`, so the cursor never leaves
  the editor.
- **Makes external files read-only**, with no configuration on your part.

## Install the `.vsix` in Cursor

Cursor uses OpenVSX, so this is a manual install — it is not published anywhere.

**From the UI:** Extensions panel → `…` menu → **Install from VSIX…** → pick
`external-libraries-0.1.0.vsix` → reload the window.

**From the command line:**

```bash
cursor --install-extension external-libraries-0.1.0.vsix
# VS Code:
code --install-extension external-libraries-0.1.0.vsix
```

Then launch the editor from inside a resolve, as usual:

```bash
rez env mytools-2.3 otherpkg-1.4 -- cursor .
```

The tree appears in the Explorer panel as **External Libraries**. There is
nothing to configure.

## Building it yourself

```bash
npm install
npm run compile
npx @vscode/vsce package --no-dependencies --allow-missing-repository
```

## Commands

All are under the **External Libraries** category in the command palette.

| Command | Where |
|---|---|
| Refresh | title bar |
| Group by Rez Packages / Show sys.path Resolution Order | title bar (toggle) |
| Reveal Active File | title bar |
| Show Diagnostics Log | title bar `…` |
| Clear Read-only Globs Written to User Settings | title bar `…` |
| Copy Path | item context menu |
| Reveal in File Explorer | item context menu |

**Show Diagnostics Log** is the first thing to open when the tree looks wrong:
it records which interpreter was picked and how, how many Rez roots were parsed,
the per-group entry counts, and any stderr the interpreter produced during the
probe.

## How read-only works

Two strategies, probed at startup with `vscode.commands.getCommands(true)`:

1. **Preferred** — `workbench.action.files.setActiveEditorReadonlyInSession`.
   Per editor, lasts only for the session, writes **nothing** to any
   `settings.json`.
2. **Fallback**, if that command does not exist in your build — a
   `files.readonlyInclude` glob for the *containing directory* (`<dir>/**`, not
   individual files), written to **user** settings via
   `ConfigurationTarget.Global`.

The workspace `.vscode/settings.json` is never touched, under any circumstance.
If you end up on the fallback and want your user settings cleaned up afterwards,
run **Clear Read-only Globs Written to User Settings** — it removes only the
globs this extension added.

> The log line `readonly: using session command` confirms you are on strategy 1.

## Performance notes

External roots are shown in a **private tree view**, never added as workspace
folders. That is deliberate: adding 30 network roots as multi-root folders drags
the file watcher and the search index into them and brings the editor to its
knees. Directory listings are lazy and cached per directory, so expanding a root
on network storage never blocks the UI.

## Known limitations

- **PEP 660 editables with a dynamic finder** (`__editable___*_finder.py`) do not
  put the source directory on `sys.path` at all, so they cannot appear in the
  tree. Only static `.pth`-based editables are detected.
- **Zip imports** (`python313.zip`) are listed but cannot be expanded. When the
  archive does not exist on disk — which is the norm for most CPython builds —
  it is shown under Standard Library with a note rather than being reported as
  unresolved.
- **Changing the Rez resolve requires relaunching the editor.** One resolve per
  session is an explicit scope decision, not a bug. Use **Refresh** after
  switching interpreters within the same resolve.
- The tree reflects `sys.path` **as reported by the interpreter at probe time**.
  Paths a package appends to `sys.path` at import time are not visible.
- Only one interpreter per session is supported; there is no multi-root,
  multi-venv mode.
