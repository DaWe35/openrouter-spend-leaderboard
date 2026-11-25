// Generates the social preview image (public/og-image.png). Needs rsvg-convert:
//   node scripts/og-image.mjs > og.svg && rsvg-convert -w 1200 -h 630 og.svg -o public/og-image.png
const P = ['#0088fe','#00c49f','#ffbb28','#ff8042','#ff6347','#4682b4','#9acd32','#da70d6','#40e0d0'];
let s = 7; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
const W = 1200, H = 630;
const x0 = 640, x1 = 1130, base = 520, n = 22, gap = 6;
const bw = (x1 - x0 - gap * (n - 1)) / n;
let bars = '';
for (let i = 0; i < n; i++) {
  const total = 120 + i * 9 + r() * 50;
  let y = base, rest = total;
  const shares = [0.32, 0.2, 0.14, 0.1, 0.08, 0.06, 0.05, 0.05];
  shares.forEach((sh, k) => {
    const h = total * sh * (0.8 + r() * 0.4);
    y -= h;
    bars += `<rect x="${(x0 + i * (bw + gap)).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${(h - 1.5).toFixed(1)}" fill="${P[k]}"/>`;
  });
}
const grid = [0, 1, 2, 3].map(k => `<line x1="${x0}" x2="${x1}" y1="${base - k * 110}" y2="${base - k * 110}" stroke="#1c2026" stroke-width="2"/>`).join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="glow" cx="0.85" cy="0.2" r="0.7"><stop offset="0" stop-color="#d4f24a" stop-opacity="0.10"/><stop offset="1" stop-color="#d4f24a" stop-opacity="0"/></radialGradient>
    <linearGradient id="fade" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#0b0d10" stop-opacity="0.55"/><stop offset="0.45" stop-color="#0b0d10" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="#0b0d10"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <rect x="600" y="70" width="560" height="500" rx="20" fill="#12151a" stroke="#262a31" stroke-width="2"/>
  ${grid}
  ${bars}
  <rect x="602" y="72" width="556" height="300" rx="18" fill="url(#fade)"/>
  <g font-family="Adwaita Sans, Inter, sans-serif">
    <rect x="70" y="92" width="14" height="14" rx="3" fill="#d4f24a"/>
    <text x="96" y="105" font-size="22" font-weight="600" fill="#a1a7b0" letter-spacing="2">OPENROUTER · USD</text>
    <text x="68" y="210" font-size="76" font-weight="700" fill="#f2f3f5" letter-spacing="-2">LLM Spend</text>
    <text x="68" y="296" font-size="76" font-weight="700" fill="#d4f24a" letter-spacing="-2">Rankings</text>
    <text x="70" y="370" font-size="28" fill="#a1a7b0">Which AI models people actually</text>
    <text x="70" y="410" font-size="28" fill="#a1a7b0">pay for: estimated dollars spent</text>
    <text x="70" y="450" font-size="28" fill="#a1a7b0">per model, updated daily.</text>
    <text x="70" y="548" font-size="24" font-weight="600" fill="#6b717b">llmspend.myqa.cc</text>
  </g>
</svg>`;
process.stdout.write(svg);
