# Building installers

PerfectSearch ships as a native installer on all three desktop platforms:

| Platform | Artifact                                | Maker                          |
|----------|-----------------------------------------|--------------------------------|
| Windows  | `PerfectSearch-Setup.exe` (Squirrel)    | `@electron-forge/maker-squirrel` |
| macOS    | `PerfectSearch-<version>.dmg`           | `@electron-forge/maker-dmg`    |
| macOS    | `PerfectSearch-<version>-mac.zip`       | `@electron-forge/maker-zip`    |
| Linux    | `perfectsearch_<version>_amd64.deb`     | `@electron-forge/maker-deb`    |
| Linux    | `perfectsearch-<version>.x86_64.rpm`    | `@electron-forge/maker-rpm`    |

All artifacts are produced under `out/make/...` after a build.

## Quick reference

```bash
npm install               # installs every runtime + build dependency
npm run build:icons       # regenerate icons (auto-runs before `make`)
npm run make:win          # Windows .exe installer
npm run make:mac          # macOS .dmg + .zip (Apple Silicon by default)
npm run make:mac:x64      # macOS .dmg for Intel Macs
npm run make:linux        # Linux .deb + .rpm
npm run make              # whatever platform you're on
```

## Cross-platform reality check

Electron Forge's makers wrap native OS tooling (Squirrel.Windows, hdiutil,
dpkg, rpmbuild). **You cannot reliably cross-build outside your own OS.**

| You're on  | Can produce                          | Need a different host for |
|------------|--------------------------------------|---------------------------|
| Windows    | `.exe`                               | `.dmg`, `.deb`, `.rpm`    |
| macOS      | `.dmg`, `.zip`, `.deb`, `.rpm`*      | `.exe` (Wine needed)      |
| Linux      | `.deb`, `.rpm`, `.exe` (with Wine)   | `.dmg`                    |

\* macOS can technically build deb/rpm but it's flaky — use Linux.

**Recommended workflow:** Push a `v*.*.*` tag and let the bundled GitHub
Actions workflow at `.github/workflows/release.yml` build all three on their
native runners and attach them to the GitHub release.

```bash
git tag v1.0.0
git push --tags
```

Within ~10 minutes you'll have a release with installers for every platform.

## Per-platform notes

### Windows
- Output: `out/make/squirrel.windows/x64/PerfectSearch-Setup.exe` (~ 90 MB).
- The installer shows a branded splash (`assets/icons/installer.png`) while
  it extracts, then launches the app. After install it's available under
  *Settings → Apps* as "PerfectSearch".
- Install location: `%LOCALAPPDATA%\PerfectSearch\`.
- To code-sign, set env vars `WINDOWS_PFX_PATH` (absolute path to your .pfx)
  and `WINDOWS_PFX_PASSWORD` before running `npm run make:win`. Without these
  the installer is unsigned and Windows SmartScreen will prompt the user
  once on first launch.

### macOS
- Output: `out/make/PerfectSearch-<version>.dmg` and a `.zip` fallback.
- The DMG opens to the "drag-to-Applications" view (`/Applications` shortcut
  next to the app icon).
- **Code signing & notarization** are strongly recommended on Mac, otherwise
  the user has to right-click → Open the first time. To enable, set:
  ```
  export APPLE_ID=you@example.com
  export APPLE_ID_PASSWORD=app-specific-password
  export APPLE_TEAM_ID=ABCDE12345
  ```
  and uncomment `osxSign` / add `osxNotarize` in `forge.config.js`.
- Apple Silicon vs Intel: use `make:mac:arm` / `make:mac:x64` to target each.
  The default `make:mac` builds the host's architecture.

### Linux
- `.deb` installs to `/opt/PerfectSearch/` with a launcher entry under
  *Office → Network*. Install: `sudo dpkg -i perfectsearch_*.deb`.
- `.rpm` mirrors that for RHEL/Fedora. Install: `sudo dnf install ./perfectsearch-*.rpm`.
- Build hosts need `dpkg` and `rpmbuild` available (`sudo apt-get install rpm
  fakeroot dpkg`).

## What gets bundled

Every dependency in `package.json` → `dependencies` is rolled into the asar
via webpack — users do **not** need to run `npm install` after installing
the app. The native modules (sharp, electron-store) are auto-unpacked from
the asar by the `plugin-auto-unpack-natives` plugin so they can load at
runtime.

The `dependencies` block currently includes:

- `electron`-side runtime: `electron-store`, `electron-squirrel-startup`
- Connectors / scraping: `axios`, `cheerio`, `node-html-parser`, `flexsearch`
- AI: `@anthropic-ai/sdk`
- UI: `react`, `react-dom`, `tailwindcss`, `@tailwindcss/forms`,
  `canvas-confetti`, `date-fns`, `lodash.debounce`
- Config: `dotenv`, `postcss`, `autoprefixer`

End users install the .exe / .dmg / .deb / .rpm and the app **just works** —
no Node, no npm, no manual steps.

## Verifying a build locally

After `npm run make:<platform>`:

```bash
ls -R out/make/
```

You'll see the installer file(s). Double-click to test the installer flow
end-to-end. The packaged app picks up its config from the same
`electron-store` location it uses in dev (`%APPDATA%/PerfectSearch/` on Win,
`~/Library/Application Support/PerfectSearch/` on Mac,
`~/.config/PerfectSearch/` on Linux), so previously-saved API keys and
connector tokens carry over.

## Bumping the version

Edit `package.json` → `"version": "x.y.z"` and tag:

```bash
git commit -am "Release vX.Y.Z"
git tag vX.Y.Z
git push && git push --tags
```

The release workflow then produces a GitHub Release with all installers
attached.
