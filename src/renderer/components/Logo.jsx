import React from 'react';

/**
 * PerfectSearch brand mark — a stylized "digital brain" / neural network.
 *
 * Design intent (matches the reference brain image the user provided):
 *   - Dark midnight-navy squircle backdrop, giving the cyan glow contrast.
 *   - Brain silhouette traced as a smooth bezier blob with a soft inner halo.
 *   - A network of small nodes ("neurons") wired by curved synaptic lines —
 *     the lines and dots use the same cyan family so the structure reads as
 *     coherent circuitry rather than random dots.
 *   - Two orange "active" neurons add a focal asymmetry and pick up the warm
 *     accent from the reference image.
 *   - SVG filter `glow` produces the bloom around each node so the icon
 *     reads as luminous even at 16x16 in a taskbar.
 *   - Every gradient / filter ID is suffixed with React.useId() so multiple
 *     `<Logo/>` instances on one page don't collide.
 */
export default function Logo({ size = 32, className = '', withGlow = false }) {
    const uid = React.useId().replace(/:/g, '');
    return (
        <span
            className={`inline-flex items-center justify-center ${className} ${withGlow ? 'drop-shadow-[0_4px_18px_rgba(34,211,238,0.55)]' : ''}`}
            style={{ width: size, height: size }}
        >
            <svg
                viewBox="0 0 64 64"
                width={size}
                height={size}
                xmlns="http://www.w3.org/2000/svg"
                role="img"
                aria-label="PerfectSearch"
            >
                <defs>
                    <linearGradient id={`bg-${uid}`} x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
                        <stop offset="0" stopColor="#0b1228" />
                        <stop offset="1" stopColor="#1e1b4b" />
                    </linearGradient>
                    <radialGradient id={`halo-${uid}`} cx="0.5" cy="0.5" r="0.55">
                        <stop offset="0" stopColor="#22d3ee" stopOpacity="0.45" />
                        <stop offset="0.75" stopColor="#22d3ee" stopOpacity="0.05" />
                        <stop offset="1" stopColor="#22d3ee" stopOpacity="0" />
                    </radialGradient>
                    <linearGradient id={`stroke-${uid}`} x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0" stopColor="#67e8f9" />
                        <stop offset="1" stopColor="#0ea5e9" />
                    </linearGradient>
                    <radialGradient id={`hot-${uid}`} cx="0.4" cy="0.4" r="0.6">
                        <stop offset="0" stopColor="#fef3c7" />
                        <stop offset="0.5" stopColor="#fb923c" />
                        <stop offset="1" stopColor="#c2410c" />
                    </radialGradient>
                    <filter id={`glow-${uid}`} x="-50%" y="-50%" width="200%" height="200%">
                        <feGaussianBlur stdDeviation="0.6" result="b" />
                        <feMerge>
                            <feMergeNode in="b" />
                            <feMergeNode in="SourceGraphic" />
                        </feMerge>
                    </filter>
                </defs>

                {/* Midnight squircle */}
                <rect width="64" height="64" rx="14" fill={`url(#bg-${uid})`} />

                {/* Soft inner halo behind the brain */}
                <ellipse cx="32" cy="33" rx="22" ry="19" fill={`url(#halo-${uid})`} />

                {/* Brain silhouette — two overlapping lobes via smooth bezier path */}
                <path
                    d="M22 18 C16 19 12 24 13 30 C9 33 11 39 16 41 C17 47 24 50 30 47 C33 50 39 49 41 45 C48 47 53 41 51 35 C55 32 53 25 48 24 C46 17 38 14 32 18 C29 15 24 15 22 18 Z"
                    fill="#0ea5e9"
                    fillOpacity="0.08"
                    stroke={`url(#stroke-${uid})`}
                    strokeWidth="0.6"
                    strokeOpacity="0.7"
                />

                {/* Synaptic connection lines */}
                <g stroke="#22d3ee" strokeWidth="0.45" strokeOpacity="0.55" fill="none" strokeLinecap="round">
                    <path d="M21 24 Q26 22 30 26" />
                    <path d="M30 26 Q34 22 39 25" />
                    <path d="M39 25 Q44 27 46 32" />
                    <path d="M21 24 Q19 30 23 34" />
                    <path d="M23 34 Q28 32 30 26" />
                    <path d="M23 34 Q27 38 30 42" />
                    <path d="M30 42 Q35 40 38 36" />
                    <path d="M38 36 Q43 34 46 32" />
                    <path d="M38 36 Q41 40 39 44" />
                    <path d="M30 26 L34 32" />
                    <path d="M34 32 L38 36" />
                    <path d="M34 32 L30 42" />
                    <path d="M34 32 Q36 28 39 25" />
                </g>

                {/* Cyan neuron nodes */}
                <g fill="#67e8f9" filter={`url(#glow-${uid})`}>
                    <circle cx="21" cy="24" r="1.1" />
                    <circle cx="30" cy="26" r="1.1" />
                    <circle cx="39" cy="25" r="1.1" />
                    <circle cx="46" cy="32" r="1.1" />
                    <circle cx="23" cy="34" r="1.1" />
                    <circle cx="34" cy="32" r="1.3" />
                    <circle cx="30" cy="42" r="1.1" />
                    <circle cx="38" cy="36" r="1.1" />
                    <circle cx="39" cy="44" r="1.1" />
                </g>

                {/* Smaller background "spark" dots for density */}
                <g fill="#22d3ee" opacity="0.55">
                    <circle cx="26" cy="30" r="0.55" />
                    <circle cx="33" cy="38" r="0.55" />
                    <circle cx="42" cy="28" r="0.55" />
                    <circle cx="25" cy="40" r="0.55" />
                    <circle cx="35" cy="22" r="0.55" />
                    <circle cx="44" cy="38" r="0.55" />
                </g>

                {/* Two "active" orange neurons — focal accents */}
                <g filter={`url(#glow-${uid})`}>
                    <circle cx="34" cy="32" r="2" fill={`url(#hot-${uid})`} />
                    <circle cx="46" cy="32" r="1.7" fill={`url(#hot-${uid})`} />
                </g>
            </svg>
        </span>
    );
}
