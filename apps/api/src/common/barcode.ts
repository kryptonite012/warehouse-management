import * as QRCode from 'qrcode';

// Code 128 (subset B) bar patterns, index = symbol value. Each digit is a module width
// alternating bar/space, starting with a bar.
const PATTERNS = [
  '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213','221312','231212','112232','122132','122231','113222','123122','123221','223211','221132','221231','213212','223112','312131','311222','321122','321221','312212','322112','322211','212123','212321','232121','111323','131123','131321','112313','132113','132311','211313','231113','231311','112133','112331','132131','113123','113321','133121','313121','211331','231131','213113','213311','213131','311123','311321','331121','312113','312311','332111','314111','221411','431111','111224','111422','121124','121421','141122','141221','112214','112412','122114','122411','142112','142211','241211','221114','413111','241112','134111','111242','121142','121241','114212','124112','124211','411212','421112','421211','212141','214121','412121','111143','111341','131141','114113','114311','411113','411311','113141','114131','311141','411131','211412','211214','211232','2331112',
];
const START_B = 104;
const STOP = 106;

/** Render a Code 128-B barcode as a standalone SVG string. */
export function code128Svg(text: string, opts: { height?: number; module?: number } = {}): string {
  if (!/^[\x20-\x7E]{1,80}$/.test(text)) throw new Error('Code128-B supports printable ASCII up to 80 chars');
  const codes = [START_B, ...[...text].map((c) => c.charCodeAt(0) - 32)];
  const checksum = codes.reduce((sum, v, i) => sum + v * (i === 0 ? 1 : i), 0) % 103;
  codes.push(checksum, STOP);

  const m = opts.module ?? 2;
  const h = opts.height ?? 80;
  const quiet = 10 * m;
  let x = quiet;
  const rects: string[] = [];
  for (const code of codes) {
    const pattern = PATTERNS[code];
    for (let i = 0; i < pattern.length; i++) {
      const w = Number(pattern[i]) * m;
      if (i % 2 === 0) rects.push(`<rect x="${x}" y="0" width="${w}" height="${h}"/>`);
      x += w;
    }
  }
  const width = x + quiet;
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h + 20}" viewBox="0 0 ${width} ${h + 20}">` +
    `<rect width="100%" height="100%" fill="#fff"/><g fill="#000">${rects.join('')}</g>` +
    `<text x="${width / 2}" y="${h + 15}" font-family="monospace" font-size="12" text-anchor="middle">${esc}</text></svg>`
  );
}

export function qrSvg(text: string): Promise<string> {
  return QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
}

/** GS1 mod-10 check digit for EAN-13 generation from a 12-digit body. */
export function ean13CheckDigit(body12: string): number {
  const sum = [...body12].reduce((s, d, i) => s + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10;
}

export function isValidEan13(code: string): boolean {
  return /^\d{13}$/.test(code) && ean13CheckDigit(code.slice(0, 12)) === Number(code[12]);
}
