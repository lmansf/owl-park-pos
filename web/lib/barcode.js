'use strict';
// Code 39 SVG renderer — zero-dep. Charset: 0-9 A-Z space - . $ / + %
// Usage: barcode39(el, "T-ABC123XYZ9") or html = barcode39Svg(code, {height})
(function () {
  // 9 elements per char (bar,space,bar,...), n = narrow, w = wide
  const C39 = {
    '0': 'nnnwwnwnn', '1': 'wnnwnnnnw', '2': 'nnwwnnnnw', '3': 'wnwwnnnnn',
    '4': 'nnnwwnnnw', '5': 'wnnwwnnnn', '6': 'nnwwwnnnn', '7': 'nnnwnnwnw',
    '8': 'wnnwnnwnn', '9': 'nnwwnnwnn',
    'A': 'wnnnnwnnw', 'B': 'nnwnnwnnw', 'C': 'wnwnnwnnn', 'D': 'nnnnwwnnw',
    'E': 'wnnnwwnnn', 'F': 'nnwnwwnnn', 'G': 'nnnnnwwnw', 'H': 'wnnnnwwnn',
    'I': 'nnwnnwwnn', 'J': 'nnnnwwwnn', 'K': 'wnnnnnnww', 'L': 'nnwnnnnww',
    'M': 'wnwnnnnwn', 'N': 'nnnnwnnww', 'O': 'wnnnwnnwn', 'P': 'nnwnwnnwn',
    'Q': 'nnnnnnwww', 'R': 'wnnnnnwwn', 'S': 'nnwnnnwwn', 'T': 'nnnnwnwwn',
    'U': 'wwnnnnnnw', 'V': 'nwwnnnnnw', 'W': 'wwwnnnnnn', 'X': 'nwnnwnnnw',
    'Y': 'wwnnwnnnn', 'Z': 'nwwnwnnnn', '-': 'nwnnnnwnw', '.': 'wwnnnnwnn',
    ' ': 'nwwnnnwnn', '$': 'nwnwnwnnn', '/': 'nwnwnnnwn', '+': 'nwnnnwnwn',
    '%': 'nnnwnwnwn', '*': 'nwnnwnwnn',
  };
  const NARROW = 2, WIDE = 5, GAP = NARROW;

  function barcode39Svg(text, { height = 56, showText = true } = {}) {
    const payload = String(text).toUpperCase();
    const full = '*' + payload + '*';
    let x = 0;
    const rects = [];
    for (const ch of full) {
      const pat = C39[ch];
      if (!pat) throw new Error(`Code 39 cannot encode "${ch}"`);
      for (let i = 0; i < 9; i++) {
        const wPx = pat[i] === 'w' ? WIDE : NARROW;
        if (i % 2 === 0) rects.push(`<rect x="${x}" y="0" width="${wPx}" height="${height}"/>`);
        x += wPx;
      }
      x += GAP;
    }
    x -= GAP;
    const textH = showText ? 16 : 0;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${x} ${height + textH}"
      width="${x}" height="${height + textH}" role="img" aria-label="${payload}"
      style="max-width:100%;height:auto">
      <g fill="currentColor">${rects.join('')}</g>
      ${showText ? `<text x="${x / 2}" y="${height + 13}" text-anchor="middle"
        font-family="monospace" font-size="13" fill="currentColor">${payload}</text>` : ''}
    </svg>`;
  }

  function barcode39(el, text, opts) {
    el.innerHTML = barcode39Svg(text, opts);
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { barcode39Svg };
  } else {
    window.barcode39 = barcode39;
    window.barcode39Svg = barcode39Svg;
  }
})();
