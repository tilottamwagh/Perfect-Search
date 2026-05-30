import confetti from 'canvas-confetti';

// Brand-aware palettes — keyed by the same color names LoginPanel uses for
// each source. The connector-confetti picks the matching palette so e.g.
// connecting Slack rains purple, ServiceNow rains green, etc.
const PALETTES = {
    brand: ['#6366f1', '#a855f7', '#ec4899', '#22d3ee', '#fb923c'],
    purple: ['#a855f7', '#c084fc', '#d8b4fe', '#e9d5ff'],
    blue: ['#3b82f6', '#60a5fa', '#93c5fd', '#bfdbfe'],
    green: ['#10b981', '#34d399', '#6ee7b7', '#a7f3d0'],
    sky: ['#0ea5e9', '#38bdf8', '#7dd3fc', '#bae6fd'],
    indigo: ['#6366f1', '#818cf8', '#a5b4fc', '#c7d2fe'],
    cyan: ['#06b6d4', '#22d3ee', '#67e8f9', '#a5f3fc'],
    amber: ['#f59e0b', '#fbbf24', '#fcd34d', '#fde68a'],
    violet: ['#7c3aed', '#8b5cf6', '#a78bfa', '#c4b5fd'],
    orange: ['#ea580c', '#f97316', '#fb923c', '#fdba74'],
};

// Electron's renderer CSP blocks blob: workers, which canvas-confetti uses by
// default. We sidestep that entirely by creating a fixed full-window canvas
// and binding a worker-less confetti instance to it. Same visuals, no CSP
// changes required.
let fireConfetti = null;

function ensureFire() {
    if (fireConfetti || typeof document === 'undefined') return fireConfetti;
    const canvas = document.createElement('canvas');
    canvas.style.position = 'fixed';
    canvas.style.inset = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.pointerEvents = 'none';
    canvas.style.zIndex = '9999';
    document.body.appendChild(canvas);
    fireConfetti = confetti.create(canvas, { resize: true, useWorker: false });
    return fireConfetti;
}

/**
 * Welcome blast: two side cannons firing toward the centre. Use on app open.
 * Slightly delayed so React has time to paint the dashboard before particles
 * start flying — landing on a still-empty canvas would feel wrong.
 */
export function welcomeConfetti() {
    const fire = ensureFire();
    if (!fire) return;
    const colors = PALETTES.brand;
    setTimeout(() => {
        fire({ particleCount: 90, angle: 60, spread: 75, startVelocity: 55, origin: { x: 0, y: 0.7 }, colors, scalar: 0.9 });
        fire({ particleCount: 90, angle: 120, spread: 75, startVelocity: 55, origin: { x: 1, y: 0.7 }, colors, scalar: 0.9 });
    }, 400);
    // Second wave for sustained celebration
    setTimeout(() => {
        fire({ particleCount: 70, angle: 60, spread: 100, startVelocity: 45, origin: { x: 0, y: 0.8 }, colors, scalar: 0.8 });
        fire({ particleCount: 70, angle: 120, spread: 100, startVelocity: 45, origin: { x: 1, y: 0.8 }, colors, scalar: 0.8 });
    }, 900);
}

/**
 * Connector blast: a single celebration burst tinted in the source's brand
 * colour. Triggered when SSO login completes successfully for any connector.
 */
export function connectorConfetti(colorName) {
    const fire = ensureFire();
    if (!fire) return;
    const palette = PALETTES[colorName] || PALETTES.brand;
    // Two quick bursts from slightly off-centre for movement
    fire({ particleCount: 120, spread: 90, startVelocity: 45, origin: { x: 0.4, y: 0.65 }, colors: palette, scalar: 0.95 });
    setTimeout(() => {
        fire({ particleCount: 60, spread: 110, startVelocity: 35, origin: { x: 0.6, y: 0.7 }, colors: palette, scalar: 0.85 });
    }, 220);
}
