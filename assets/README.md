# Brand assets

## Logo: `brain.png`

The header logo prefers a file at **`assets/brain.png`** (the photographic-style digital brain image). To use it:

1. Save your digital-brain image as `brain.png` in this folder.
2. Restart the app (or just refresh — Electron picks it up via the `app://` protocol on next request).
3. The header will show your image at 44×44 px with rounded corners (~22% radius for the AWS-service-icon look).

**Format suggestions:** PNG with transparent background recommended; JPG works too. Any square-ish image works — `objectFit: cover` will fill the rounded box. Source the image at ≥256×256 for crisp rendering on high-DPI displays.

If `brain.png` is missing or fails to load, the app silently falls back to the inline SVG digital brain (see `src/renderer/components/Logo.jsx`).

## App icon: `icon.png` / `icon.ico`

For the OS taskbar / Windows installer icon, drop a 256×256 (or multi-res `.ico`) at `assets/icon.png` or `assets/icon.ico`. Main process picks it up via `resolveAppIcon()` in `src/main.js`.

## Logo SVG: `logo.svg`

The standalone vector version of the digital-brain mark — used in the README. Same design as the inline SVG fallback in `Logo.jsx`.
