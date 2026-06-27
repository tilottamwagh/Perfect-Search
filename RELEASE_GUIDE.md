# PerfectSearch — Step-by-Step Release Guide

> A complete guide for making code changes, pushing them to GitHub, and creating a new release with installers.
> **Written so simply that a 5-year-old could follow it.** 🍼

---

## 📋 Table of Contents

1. [What you need before starting](#-what-you-need-before-starting-one-time-setup)
2. [Part A — Make a small code change](#-part-a--make-a-small-code-change)
3. [Part B — Test your change locally](#-part-b--test-your-change-locally)
4. [Part C — Save your change to GitHub](#-part-c--save-your-change-to-github-commit--push)
5. [Part D — Create a new release with installers](#-part-d--create-a-new-release-with-installers-github-actions)
6. [Part E — Build the installer on YOUR computer (if GitHub Actions runs out)](#-part-e--build-the-installer-on-your-computer-if-github-actions-runs-out)
7. [Part F — Upload your local installer to GitHub Release](#-part-f--upload-your-local-installer-to-github-release)
8. [Common problems and how to fix them](#-common-problems-and-how-to-fix-them)
9. [Quick reference — copy-paste commands](#-quick-reference--copy-paste-commands)

---

## ✅ What you need before starting (one-time setup)

These are already installed on your computer, but if you ever set up a new machine, you'll need:

| Tool | What it's for | How to get it |
|---|---|---|
| **Node.js v20** | Runs the app | https://nodejs.org → Download v20 LTS |
| **Git** | Saves code changes | https://git-scm.com/download/win |
| **GitHub CLI (`gh`)** | Talks to GitHub from terminal | https://cli.github.com |
| **VS Code** (optional) | Edits the code | https://code.visualstudio.com |

To check they're installed, open **PowerShell** and type:
```powershell
node --version    # Should show v20.x.x
git --version     # Should show git version 2.x.x
gh --version      # Should show gh version 2.x.x
```

If `gh` says you're not logged in, run:
```powershell
gh auth login
```
Choose: **GitHub.com** → **HTTPS** → **Login with web browser** → follow the prompts.

---

## 🛠️ Part A — Make a small code change

### Step 1 — Open the project folder

Open **PowerShell** and go to the project:
```powershell
cd "E:\AntiGravity\Autonomus AI\omnisearch"
```

### Step 2 — Make sure you have the latest code

Always pull the latest changes BEFORE editing, so you don't conflict with past work:
```powershell
git pull origin main
```

You should see either "Already up to date" or a list of new changes. ✅

### Step 3 — Edit the code

Open the file you want to change in VS Code:
```powershell
code .
```

Make your changes and **save the file** (`Ctrl+S`).

### Step 4 — See what files you changed

```powershell
git status
```

You'll see something like:
```
modified:   src/ai/bedrock.js
modified:   src/renderer/App.jsx
```

These are the files you edited. Good. ✅

---

## 🧪 Part B — Test your change locally

### Step 1 — Stop any running instance of the app

If PerfectSearch is already open, close it first:
```powershell
taskkill /F /IM electron.exe
```

(If it says "process not found", that's fine — it means the app wasn't running.)

### Step 2 — Start the app

```powershell
npm start
```

Wait ~10-20 seconds. The PerfectSearch window will open.

### Step 3 — Test your change

Click through the feature you changed. Make sure it works the way you expect.

### Step 4 — Close the app when done

Just close the window normally, or:
```powershell
taskkill /F /IM electron.exe
```

---

## 💾 Part C — Save your change to GitHub (commit + push)

### Step 1 — Add your changed files

To add ALL changed files:
```powershell
git add .
```

To add only specific files (safer):
```powershell
git add src/ai/bedrock.js src/renderer/App.jsx
```

### Step 2 — Commit (save) the change

Always write a clear message describing WHAT you changed and WHY:
```powershell
git commit -m "fix: Bedrock now accepts long-term ABSK keys"
```

✅ Good commit message examples:
- `fix: Bedrock now accepts long-term ABSK keys`
- `feat: add ServiceNow scroll independence`
- `chore: bump version to 1.3.1`

❌ Bad commit message examples (don't do these):
- `update`
- `fix bug`
- `changes`

### Step 3 — Push to GitHub

```powershell
git push origin main
```

You'll see something like:
```
To https://github.com/tilottamwagh/Perfect-Search.git
   abc1234..def5678  main -> main
```

✅ Your change is now on GitHub.

### Step 4 — Verify on GitHub

Open this in your browser:
👉 https://github.com/tilottamwagh/Perfect-Search/commits/main

You should see your new commit at the top.

---

## 🚀 Part D — Create a new release with installers (GitHub Actions)

This is how you build **Windows + Mac + Linux installers** automatically and put them on a GitHub Release.

### Step 1 — Decide on the new version number

Open `package.json` and find this line:
```json
"version": "1.3.0",
```

Bump it following these rules:
- **Small bug fix:** `1.3.0` → `1.3.1`
- **New feature:** `1.3.0` → `1.4.0`
- **Big breaking change:** `1.3.0` → `2.0.0`

Change the number, save the file (`Ctrl+S`).

### Step 2 — Commit the version bump

```powershell
git add package.json
git commit -m "chore: bump version to 1.3.1"
git push origin main
```

### Step 3 — Create a version tag

A "tag" is like a bookmark in your code history. GitHub Actions watches for tags starting with `v` to trigger installer builds.

```powershell
git tag v1.3.1
git push origin v1.3.1
```

**⚠️ Important:** The tag MUST match the version in `package.json` and MUST start with `v`.

### Step 4 — Watch the build run

Open this in your browser:
👉 https://github.com/tilottamwagh/Perfect-Search/actions

You should see a yellow circle (🟡) next to "Build installers" — it's running!

- ⏳ Wait time: **10-15 minutes**
- ✅ Green checkmark = success
- ❌ Red X = failure (see "Common problems" below)

### Step 5 — Find your release

When done, your release appears here:
👉 https://github.com/tilottamwagh/Perfect-Search/releases

You'll see installers attached:
- 🪟 `PerfectSearch-1.3.1 Setup.exe` (Windows)
- 🍎 `PerfectSearch-1.3.1.dmg` (Mac)
- 🐧 `perfectsearch_1.3.1_amd64.deb` (Linux Debian/Ubuntu)
- 🐧 `perfectsearch-1.3.1-1.x86_64.rpm` (Linux Red Hat/Fedora)

✅ **Done!** Share the release URL with your team — they download the installer for their OS and run it.

---

## 🔧 Part E — Build the installer on YOUR computer (if GitHub Actions runs out)

GitHub gives you free Actions minutes each month. If you run out, you can build the **Windows installer** yourself.

### Step 1 — Stop any running app

```powershell
taskkill /F /IM electron.exe
```

### Step 2 — Make sure dependencies are installed

```powershell
cd "E:\AntiGravity\Autonomus AI\omnisearch"
npm install
```

This takes ~1-3 minutes. Only needed when `package.json` changes (rare).

### Step 3 — Build the Windows installer

```powershell
npm run make:win
```

⏳ Wait time: **3-5 minutes**

You'll see lots of text scroll by. When done you'll see:
```
✔ Making distributables
```

### Step 4 — Find your installer

The installer is at:
```
E:\AntiGravity\Autonomus AI\omnisearch\out\make\squirrel.windows\x64\PerfectSearch-1.3.1 Setup.exe
```

Open File Explorer there:
```powershell
explorer out\make\squirrel.windows\x64
```

### Step 5 — Test the installer

Double-click `PerfectSearch-1.3.1 Setup.exe`. It should install the app.

**⚠️ Note:** Windows will say "Unknown publisher" — that's normal for unsigned installers. Click **"More info" → "Run anyway"** to install.

---

## 📤 Part F — Upload your local installer to GitHub Release

If you built the installer locally, you can attach it to the GitHub release:

### Option 1 — Using the website (easiest)

1. Go to https://github.com/tilottamwagh/Perfect-Search/releases
2. Click the version you want (e.g., `v1.3.1`)
3. Click **"Edit"** (pencil icon, top-right)
4. Drag your `PerfectSearch-1.3.1 Setup.exe` file into the box that says "Attach binaries..."
5. Wait for the upload to finish
6. Click **"Update release"**

### Option 2 — Using `gh` CLI (faster)

```powershell
gh release upload v1.3.1 "out\make\squirrel.windows\x64\PerfectSearch-1.3.1 Setup.exe"
```

---

## 🐛 Common problems and how to fix them

### Problem 1 — "git push" asks for username/password

GitHub no longer accepts passwords. Use `gh auth login` once, then `git push` will use your saved token.

### Problem 2 — "npm start" fails with "port 9000 in use"

A previous app is still running:
```powershell
taskkill /F /IM electron.exe
```
Then try `npm start` again.

### Problem 3 — Tag was wrong, want to delete and re-tag

```powershell
# Delete locally
git tag -d v1.3.1

# Delete on GitHub
git push origin --delete v1.3.1

# Create the correct tag
git tag v1.3.1
git push origin v1.3.1
```

### Problem 4 — Build fails on GitHub Actions

Open the failed run, click on the red ❌ job, scroll down to find the error.

Common causes:
- **Out of credits** → Build locally (Part E) or wait for next month
- **Lint errors** → Run `npm run lint` locally and fix
- **Test failures** → Run `npm test` locally and fix

### Problem 5 — "npm install" fails

Delete `node_modules` and `package-lock.json`, then retry:
```powershell
rm -r -force node_modules
rm package-lock.json
npm install
```

### Problem 6 — Forgot to bump version before tagging

Just bump and re-tag:
```powershell
# Edit package.json → change "version" → save
git add package.json
git commit -m "chore: bump version"
git push

git tag -d v1.3.1                      # delete local tag
git push origin --delete v1.3.1        # delete remote tag
git tag v1.3.1
git push origin v1.3.1                 # re-trigger build
```

### Problem 7 — Made a mistake and want to undo last commit (before pushing)

```powershell
git reset --soft HEAD~1
```
This keeps your changes but removes the commit. Edit and re-commit.

**⚠️ Never** do this AFTER pushing — it rewrites history and confuses everyone.

---

## ⚡ Quick reference — copy-paste commands

### Daily workflow (small change → push)
```powershell
cd "E:\AntiGravity\Autonomus AI\omnisearch"
git pull origin main
# ... edit files ...
git add .
git commit -m "fix: describe what you did"
git push origin main
```

### Release workflow (build installers)
```powershell
# 1. Bump version in package.json (e.g. 1.3.0 → 1.3.1)
git add package.json
git commit -m "chore: bump version to 1.3.1"
git push origin main

# 2. Tag and push
git tag v1.3.1
git push origin v1.3.1

# 3. Watch the build
start https://github.com/tilottamwagh/Perfect-Search/actions
```

### Local Windows build (no GitHub Actions needed)
```powershell
cd "E:\AntiGravity\Autonomus AI\omnisearch"
taskkill /F /IM electron.exe
npm run make:win
explorer out\make\squirrel.windows\x64
```

### Upload local build to existing release
```powershell
gh release upload v1.3.1 "out\make\squirrel.windows\x64\PerfectSearch-1.3.1 Setup.exe"
```

### Re-run a failed GitHub Action
1. Go to https://github.com/tilottamwagh/Perfect-Search/actions
2. Click the failed run
3. Click **"Re-run failed jobs"** in top-right

---

## 🎯 Summary — the 3 things to remember

1. **Always pull before editing:** `git pull origin main`
2. **Always commit with a clear message:** `git commit -m "fix: something specific"`
3. **Always bump version AND tag together** before triggering a release:
   ```powershell
   # Edit package.json version, then:
   git add package.json && git commit -m "chore: bump version" && git push
   git tag v1.3.1 && git push origin v1.3.1
   ```

That's it! Save this file — you can come back to it anytime you forget. 🚀

---

*Last updated: 2026-06-27 · For version 1.3.0 of PerfectSearch*
