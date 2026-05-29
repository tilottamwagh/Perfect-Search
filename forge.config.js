const path = require('path');
const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

// All installer artifacts share these brand strings — keep them in sync with
// package.json's `productName` / `description` / author.
const APP_NAME = 'PerfectSearch';
const APP_DESCRIPTION = 'Unified enterprise desktop search — Slack, Confluence, ServiceNow, Atlassian, Box, Jira, Resources & web research with AI synthesis.';
const APP_AUTHOR = 'Tilottam Wagh';
const APP_HOMEPAGE = 'https://github.com/tilottamwagh/Perfect-Search';

const ICONS = {
  png:  path.resolve(__dirname, 'assets', 'icons', 'icon.png'),
  ico:  path.resolve(__dirname, 'assets', 'icons', 'icon.ico'),
  icns: path.resolve(__dirname, 'assets', 'icons', 'icon.icns'),
  installerSplash: path.resolve(__dirname, 'assets', 'icons', 'installer.png'),
};

module.exports = {
  packagerConfig: {
    // .icns/.ico/.png suffix is auto-appended per platform when no extension
    // is given, so we hand Electron Packager the base path and let it pick.
    icon: path.resolve(__dirname, 'assets', 'icons', 'icon'),
    name: APP_NAME,
    executableName: 'PerfectSearch',
    appBundleId: 'com.tilottamwagh.perfectsearch',
    appCategoryType: 'public.app-category.productivity',
    asar: true,
    // Ship the LICENSE in every package so distros show it in their "About".
    extraResource: [],
    // Quiet the packaged-app warning shown when no code-signing identity is
    // configured. Users still get an unsigned-app prompt on first launch on
    // mac/Windows until certificates are added — documented in BUILD.md.
    osxSign: false,
    win32metadata: {
      CompanyName: APP_AUTHOR,
      ProductName: APP_NAME,
      FileDescription: APP_DESCRIPTION,
      OriginalFilename: 'PerfectSearch.exe',
    },
  },

  rebuildConfig: {},

  makers: [
    // ── Windows ─────────────────────────────────────────────────────────────
    // Squirrel.Windows: produces a single setup .exe and an .nupkg, supports
    // delta auto-updates if you later add an update server. Shows a branded
    // splash (loadingGif) while extracting, then launches the app.
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'PerfectSearch',
        authors: APP_AUTHOR,
        description: APP_DESCRIPTION,
        exe: 'PerfectSearch.exe',
        setupExe: 'PerfectSearch-Setup.exe',
        // Icon shown in Add/Remove Programs + the installer .exe icon.
        setupIcon: ICONS.ico,
        iconUrl: 'https://raw.githubusercontent.com/tilottamwagh/Perfect-Search/main/assets/icons/icon.ico',
        // Branded splash displayed during install. Must be a PNG.
        loadingGif: ICONS.installerSplash,
        // Optional: registers the app for auto-update via Squirrel events.
        // Skip code signing unless WINDOWS_PFX_PATH env var is set.
        certificateFile: process.env.WINDOWS_PFX_PATH || undefined,
        certificatePassword: process.env.WINDOWS_PFX_PASSWORD || undefined,
        noMsi: false,
      },
    },

    // ── macOS ──────────────────────────────────────────────────────────────
    // DMG: the standard "drag the app to Applications" installer. Looks
    // proper, mounts as a disk image, branded with our icon.
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: {
        name: APP_NAME,
        icon: ICONS.icns,
        format: 'ULFO', // LZFSE-compressed, smaller download
        overwrite: true,
        contents: (opts) => [
          { x: 130, y: 220, type: 'file', path: opts.appPath },
          { x: 410, y: 220, type: 'link', path: '/Applications' },
        ],
      },
    },
    // Also produce a .zip fallback for users who prefer a portable archive.
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },

    // ── Linux ───────────────────────────────────────────────────────────────
    // .deb: Debian/Ubuntu/Mint/PopOS. Installs to /opt/PerfectSearch with a
    // /usr/share/applications/.desktop entry — shows up in the launcher.
    {
      name: '@electron-forge/maker-deb',
      platforms: ['linux'],
      config: {
        options: {
          name: 'perfectsearch',
          productName: APP_NAME,
          genericName: 'Enterprise Search',
          description: APP_DESCRIPTION,
          maintainer: APP_AUTHOR,
          homepage: APP_HOMEPAGE,
          icon: ICONS.png,
          categories: ['Office', 'Network', 'Utility'],
          section: 'utils',
        },
      },
    },
    // .rpm: Fedora/RHEL/CentOS/openSUSE.
    {
      name: '@electron-forge/maker-rpm',
      platforms: ['linux'],
      config: {
        options: {
          name: 'perfectsearch',
          productName: APP_NAME,
          genericName: 'Enterprise Search',
          description: APP_DESCRIPTION,
          license: 'MIT',
          homepage: APP_HOMEPAGE,
          icon: ICONS.png,
          categories: ['Office', 'Network', 'Utility'],
        },
      },
    },
  ],

  plugins: [
    // Unpack native modules (e.g. sharp / electron-store native deps) from
    // the asar so they can be loaded at runtime.
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
    {
      name: '@electron-forge/plugin-webpack',
      config: {
        mainConfig: './webpack.main.config.js',
        renderer: {
          config: './webpack.renderer.config.js',
          entryPoints: [
            {
              html: './src/renderer/index.html',
              js: './src/renderer/index.jsx',
              name: 'main_window',
              preload: {
                js: './src/preload.js',
              },
            },
          ],
        },
      },
    },

    // Hardening fuses — disabled features can't be re-enabled at runtime,
    // so attackers who modify the bundle can't (for example) flip on
    // RunAsNode to load arbitrary scripts.
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
