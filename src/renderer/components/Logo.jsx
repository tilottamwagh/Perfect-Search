import React from 'react';

/**
 * PerfectSearch brand mark — Shri Yantra geometry.
 *
 * The Shri Yantra is an ancient (centuries-old) traditional diagram from the
 * Indian tantric tradition — the geometric form itself is firmly in the
 * public domain. What you see below is original SVG art representing that
 * traditional geometry: a bhupura square enclosure, an eight-petal lotus
 * ring, four upward and five downward interlocking triangles, and the
 * central bindu point.
 *
 * Rendering is optimised for small sizes (~44px on the dashboard): inner
 * lotus ring is kept simple (8 petals only, no 16-petal outer ring), strokes
 * are tuned for crispness, and shape-rendering is set to geometricPrecision.
 *
 * If a raster brand image is later dropped at `assets/brain.png`, we'll
 * prefer it (served through the app:// protocol registered in main.js) and
 * fall back to this SVG if it fails to load.
 */
export default function Logo({ size = 44, className = '', withGlow = false, preferRaster = false }) {
    const uid = React.useId().replace(/:/g, '');
    const [imgFailed, setImgFailed] = React.useState(!preferRaster);

    const glowClass = withGlow ? 'drop-shadow-[0_4px_18px_rgba(251,191,36,0.45)]' : '';

    if (!imgFailed) {
        return (
            <span
                className={`inline-flex items-center justify-center ${className} ${glowClass}`}
                style={{ width: size, height: size }}
            >
                <img
                    src="app://brain.png"
                    width={size}
                    height={size}
                    alt="PerfectSearch"
                    onError={() => setImgFailed(true)}
                    style={{
                        width: size,
                        height: size,
                        borderRadius: `${Math.round(size * 0.22)}px`,
                        objectFit: 'cover',
                        display: 'block',
                        imageRendering: '-webkit-optimize-contrast',
                    }}
                />
            </span>
        );
    }

    return (
        <span
            className={`inline-flex items-center justify-center ${className} ${glowClass}`}
            style={{ width: size, height: size }}
        >
            <svg
                viewBox="0 0 128 128"
                width={size}
                height={size}
                xmlns="http://www.w3.org/2000/svg"
                role="img"
                aria-label="PerfectSearch"
                shapeRendering="geometricPrecision"
            >
                <defs>
                    <linearGradient id={`bg-${uid}`} x1="0" y1="0" x2="128" y2="128" gradientUnits="userSpaceOnUse">
                        <stop offset="0" stopColor="#0a0f25" />
                        <stop offset="1" stopColor="#080d1f" />
                    </linearGradient>
                    <radialGradient id={`halo-${uid}`} cx="0.5" cy="0.5" r="0.55">
                        <stop offset="0" stopColor="#fde047" stopOpacity="0.4" />
                        <stop offset="1" stopColor="#fbbf24" stopOpacity="0" />
                    </radialGradient>
                    <radialGradient id={`bindu-${uid}`} cx="0.45" cy="0.4" r="0.6">
                        <stop offset="0" stopColor="#fef3c7" />
                        <stop offset="0.4" stopColor="#fbbf24" />
                        <stop offset="1" stopColor="#b45309" />
                    </radialGradient>
                    <linearGradient id={`gold-${uid}`} x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0" stopColor="#fde047" />
                        <stop offset="1" stopColor="#f59e0b" />
                    </linearGradient>
                    <filter id={`glow-${uid}`} x="-30%" y="-30%" width="160%" height="160%">
                        <feGaussianBlur stdDeviation="0.7" result="b" />
                        <feMerge>
                            <feMergeNode in="b" />
                            <feMergeNode in="SourceGraphic" />
                        </feMerge>
                    </filter>
                </defs>

                {/* Background tile */}
                <rect width="128" height="128" rx="22" fill={`url(#bg-${uid})`} />

                {/* Soft halo behind the diagram */}
                <circle cx="64" cy="64" r="46" fill={`url(#halo-${uid})`} />

                {/* Bhupura — single golden frame with the four T-gates */}
                <g fill="none" stroke={`url(#gold-${uid})`} strokeWidth="0.9" strokeOpacity="0.85">
                    <rect x="12" y="12" width="104" height="104" rx="2" />
                    <rect x="17" y="17" width="94" height="94" rx="1.5" strokeOpacity="0.5" />
                    {/* Cardinal gates */}
                    <path d="M58 12 L58 7 L70 7 L70 12" />
                    <path d="M58 116 L58 121 L70 121 L70 116" />
                    <path d="M12 58 L7 58 L7 70 L12 70" />
                    <path d="M116 58 L121 58 L121 70 L116 70" />
                </g>

                {/* Eight-petal lotus */}
                <g fill="none" stroke="#fde047" strokeWidth="0.7" strokeOpacity="0.75" filter={`url(#glow-${uid})`}>
                    <g transform="translate(64 64)">
                        <g><path d="M0 -40 Q -6 -32 0 -26 Q 6 -32 0 -40 Z" /></g>
                        <g transform="rotate(45)"><path d="M0 -40 Q -6 -32 0 -26 Q 6 -32 0 -40 Z" /></g>
                        <g transform="rotate(90)"><path d="M0 -40 Q -6 -32 0 -26 Q 6 -32 0 -40 Z" /></g>
                        <g transform="rotate(135)"><path d="M0 -40 Q -6 -32 0 -26 Q 6 -32 0 -40 Z" /></g>
                        <g transform="rotate(180)"><path d="M0 -40 Q -6 -32 0 -26 Q 6 -32 0 -40 Z" /></g>
                        <g transform="rotate(225)"><path d="M0 -40 Q -6 -32 0 -26 Q 6 -32 0 -40 Z" /></g>
                        <g transform="rotate(270)"><path d="M0 -40 Q -6 -32 0 -26 Q 6 -32 0 -40 Z" /></g>
                        <g transform="rotate(315)"><path d="M0 -40 Q -6 -32 0 -26 Q 6 -32 0 -40 Z" /></g>
                    </g>
                </g>

                {/* Inner enclosing ring around the triangles */}
                <circle cx="64" cy="64" r="26" fill="none" stroke="#fde047" strokeWidth="0.7" strokeOpacity="0.8" />

                {/* Four upward triangles (gold) */}
                <g fill="none" stroke={`url(#gold-${uid})`} strokeWidth="0.8" strokeOpacity="0.9" filter={`url(#glow-${uid})`}>
                    <polygon points="64,42 39,86 89,86" fill="#fbbf24" fillOpacity="0.07" />
                    <polygon points="64,48 45,82 83,82" fill="#fbbf24" fillOpacity="0.07" />
                    <polygon points="64,54 51,78 77,78" fill="#fbbf24" fillOpacity="0.07" />
                    <polygon points="64,60 56,74 72,74" fill="#fbbf24" fillOpacity="0.09" />
                </g>

                {/* Five downward triangles (cyan) */}
                <g fill="none" stroke="#22d3ee" strokeWidth="0.8" strokeOpacity="0.9" filter={`url(#glow-${uid})`}>
                    <polygon points="64,86 39,42 89,42" fill="#22d3ee" fillOpacity="0.07" />
                    <polygon points="64,80 44,46 84,46" fill="#22d3ee" fillOpacity="0.07" />
                    <polygon points="64,74 50,50 78,50" fill="#22d3ee" fillOpacity="0.07" />
                    <polygon points="64,68 54,54 74,54" fill="#22d3ee" fillOpacity="0.08" />
                    <polygon points="64,65 58,57 70,57" fill="#22d3ee" fillOpacity="0.1" />
                </g>

                {/* Bindu — the central point */}
                <g filter={`url(#glow-${uid})`}>
                    <circle cx="64" cy="64" r="3" fill={`url(#bindu-${uid})`} />
                    <circle cx="64" cy="64" r="1.1" fill="#fef3c7" />
                </g>
            </svg>
        </span>
    );
}
