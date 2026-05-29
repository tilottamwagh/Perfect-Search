/**
 * Icon pipeline for PerfectSearch installers.
 *
 * Reads `assets/logo.svg` and produces every raster format Electron Forge's
 * makers ask for:
 *
 *   assets/icons/
 *     icon.png           — 1024×1024 master (used by Linux deb/rpm)
 *     icon.ico           — multi-resolution Windows icon (16, 24, 32, 48, 64, 128, 256)
 *     icon.icns          — macOS icon set (16…1024 retina)
 *     installer.png      — Squirrel.Windows splash background (640×480 PNG, also used as loadingGif fallback)
 *     icon-256.png       — convenience copy, used by maker-dmg
 *     icon-512.png       — convenience copy, used by maker-dmg
 *     icon-1024.png      — convenience copy
 *
 * Run with: `npm run build:icons`. Idempotent — safe to re-run.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const png2icons = require('png2icons');

const ROOT = path.resolve(__dirname, '..');
const SRC_SVG = path.join(ROOT, 'assets', 'logo.svg');
const OUT_DIR = path.join(ROOT, 'assets', 'icons');

const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

async function ensureDir(p) {
    await fs.promises.mkdir(p, { recursive: true });
}

async function renderPng(svgBuffer, size) {
    return sharp(svgBuffer, { density: 384 })
        .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png({ compressionLevel: 9 })
        .toBuffer();
}

async function main() {
    if (!fs.existsSync(SRC_SVG)) {
        throw new Error(`Source SVG not found: ${SRC_SVG}`);
    }
    await ensureDir(OUT_DIR);
    const svgBuffer = await fs.promises.readFile(SRC_SVG);

    console.log('[icons] rendering PNG sizes…');
    const renderedBySize = new Map();
    for (const size of PNG_SIZES) {
        const buf = await renderPng(svgBuffer, size);
        renderedBySize.set(size, buf);
        // also persist the larger sizes individually for use by other makers
        if (size === 256 || size === 512 || size === 1024) {
            await fs.promises.writeFile(path.join(OUT_DIR, `icon-${size}.png`), buf);
        }
    }

    // Master PNG used by Linux makers (deb/rpm reference this in their config).
    await fs.promises.writeFile(path.join(OUT_DIR, 'icon.png'), renderedBySize.get(1024));
    console.log('[icons] wrote icon.png (1024×1024)');

    // Windows .ico — png2icons builds a multi-resolution ICO from a single
    // large PNG. Bicubic resize for crispness at small sizes.
    console.log('[icons] building icon.ico…');
    const icoBuf = png2icons.createICO(renderedBySize.get(1024), png2icons.BICUBIC, 0, false);
    if (!icoBuf) throw new Error('png2icons failed to produce .ico');
    await fs.promises.writeFile(path.join(OUT_DIR, 'icon.ico'), icoBuf);
    console.log('[icons] wrote icon.ico');

    // macOS .icns — same library, ICNS variant. Includes retina sizes.
    console.log('[icons] building icon.icns…');
    const icnsBuf = png2icons.createICNS(renderedBySize.get(1024), png2icons.BICUBIC, 0);
    if (!icnsBuf) throw new Error('png2icons failed to produce .icns');
    await fs.promises.writeFile(path.join(OUT_DIR, 'icon.icns'), icnsBuf);
    console.log('[icons] wrote icon.icns');

    // Squirrel.Windows installer splash. The installer briefly shows this
    // image while the app extracts — must be a 640×480 PNG that mirrors the
    // brand. We composite the logo centered on the brand-gradient background.
    console.log('[icons] building installer splash…');
    const splash = await sharp({
        create: {
            width: 640,
            height: 480,
            channels: 4,
            background: { r: 11, g: 18, b: 40, alpha: 1 },
        },
    })
        .composite([
            { input: renderedBySize.get(256), gravity: 'center' },
        ])
        .png({ compressionLevel: 9 })
        .toBuffer();
    await fs.promises.writeFile(path.join(OUT_DIR, 'installer.png'), splash);
    console.log('[icons] wrote installer.png (640×480 splash)');

    console.log('[icons] done.');
}

main().catch((err) => {
    console.error('[icons] FAILED:', err);
    process.exit(1);
});
