# Installation Guide

This covers setting up a machine from scratch to build, test, and run naimix. It's written mainly for macOS (the primary dev machine for this project), with notes for Linux and Windows where things differ.

## 1. Install nvm (Node Version Manager)

Use `nvm` instead of installing Node directly — this project needs a specific Node version range (see step 2), and `nvm` lets you switch between that and whatever else you use Node for, without conflicts.

**macOS/Linux**, pick one:

```bash
# Option A: Homebrew (macOS)
brew install nvm
# Homebrew prints a few lines to add to your shell profile (~/.zshrc or ~/.bash_profile) —
# add those before continuing, then restart your terminal or `source` the profile.

# Option B: official install script (macOS/Linux)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# This one edits your shell profile automatically. Restart your terminal afterward.
```

**Windows**: `nvm` itself is Unix shell, so Windows users should use [nvm-windows](https://github.com/coreybutler/nvm-windows) instead (a separate project, same idea) — download the installer from its Releases page.

Verify it's working:

```bash
nvm --version
```

## 2. Install Node.js — use Node 22 or 24, not the newest release

```bash
nvm install 22
nvm use 22
nvm alias default 22   # makes 22 the default for every new terminal
```

**Why not the latest Node:** one of this project's dependencies, `better-sqlite3`, compiles a native C++ addon directly against V8's API (for speed) instead of using Node's stable N-API layer. Brand-new Node releases (Node 26 as of this writing) ship a newer V8 that has renamed/removed some of the methods that addon's older source relies on, and there's no prebuilt binary yet for a Node version that new — so `npm install` fails trying to compile it from scratch. Node 22 and 24 are both known-good; the project's own type definitions (`@types/node`) are pinned to 22, and the build scripts target Node 24, so either works.

If you land on a newer Node later and see an install fail with errors like `no member named 'GetPrototype' in 'v8::Object'`, that's this exact issue — switch back with `nvm use 22` and reinstall (see Troubleshooting below).

Once set up, run this inside the `naimix` folder every time you open a new terminal (or add a `.nvmrc` file containing `22` to the repo so `nvm use` picks it automatically with no argument):

```bash
nvm use 22
```

Verify versions:

```bash
node -v   # v22.x.x
npm -v
```

## 3. Install native build tools (needed to compile `better-sqlite3`/`sqlite3`)

`npm install` will try to download a prebuilt binary for these packages first, and only fall back to compiling from source if none matches your platform/Node version exactly. Having the build tools ready means that fallback won't fail.

**macOS:**

```bash
xcode-select --install
```

(Installs the Command Line Tools, which include `make`, a C/C++ compiler, and Python 3 — all node-gyp needs.)

**Linux (Debian/Ubuntu):**

```bash
sudo apt-get update
sudo apt-get install -y build-essential python3
```

**Windows:** install the "Desktop development with C++" workload from [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/), plus Python 3 if it isn't already on your PATH.

## 4. Get the code and install dependencies

```bash
git clone <repo-url> naimix
cd naimix
nvm use 22
npm install
```

## 5. Optional, feature-specific dependencies

**Console UI "Browse…" folder picker** (workspace folder selection) shells out to each OS's native dialog tool — nothing to install on macOS or Windows (AppleScript and PowerShell are built in), but Linux needs `zenity`:

```bash
sudo apt-get install -y zenity      # Debian/Ubuntu
sudo dnf install -y zenity          # Fedora
```

**LDAP auth-provider tests** (`npm run test-ldap`) run a local OpenLDAP server via Docker Compose — install [Docker Desktop](https://www.docker.com/products/docker-desktop/) if you plan to run those.

## 6. Verify the install

From the `naimix` folder:

```bash
npx tsc --noEmit            # typechecks the server code
npm run build:qa            # builds the QA bundle
npm run build:prod          # builds the production bundle
npx vitest run              # runs the test suite
npm run dev                 # starts the full dev server (console UI + data plane)
```

If all of those run without errors, the install is good.

## Troubleshooting

**`npm install` fails compiling `better-sqlite3`, with errors mentioning `v8::Object`, `v8::Context`, or `PropertyCallbackInfo`:** you're on a Node version that's too new for the pinned `better-sqlite3` release (see step 2). Run `nvm use 22`, delete `node_modules` and `package-lock.json`, and reinstall:

```bash
nvm use 22
rm -rf node_modules package-lock.json
npm install
```

**`npm install` prints `warn ERESOLVE overriding peer dependency` mentioning `esbuild`:** this is harmless — it's npm auto-resolving a version mismatch between `vite`'s peer dependency on `esbuild` and the copy bundled inside `tsx`. It's a warning, not an error, and doesn't stop the install.

**`esbuild: cannot execute binary file` or `Exec format error` when running `npm run build:qa`/`build:prod`:** a native binary in `node_modules` was installed for the wrong OS/architecture — usually from running `npm install` inside a container, VM, or CI environment different from the machine you're now running the build on. Delete `node_modules` and reinstall on the actual target machine; don't copy `node_modules` between machines with different operating systems.
