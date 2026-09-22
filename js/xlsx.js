// Minimal .xlsx reader: returns the first worksheet as an array of string arrays.
// Uses the browser's built-in DecompressionStream — no libraries.

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function readZipEntries(buf) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx file (zip directory not found).');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const entries = {};
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt .xlsx file.');
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    entries[name] = { method, compSize, localOffset };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: Object.keys(entries),
    async text(name) {
      const e = entries[name];
      if (!e) return null;
      const lnameLen = dv.getUint16(e.localOffset + 26, true);
      const lextraLen = dv.getUint16(e.localOffset + 28, true);
      const start = e.localOffset + 30 + lnameLen + lextraLen;
      const data = u8.subarray(start, start + e.compSize);
      const out = e.method === 0 ? data : await inflateRaw(data);
      return dec.decode(out);
    },
  };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function textOf(xmlFragment) {
  let out = '';
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(xmlFragment))) out += m[1];
  return decodeXml(out);
}

function colIndex(ref) {
  const letters = ref.replace(/\d+/g, '');
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function numberToString(v) {
  // Keep long integers (ISBNs) intact; avoid "9.78E+12" style output.
  if (/e/i.test(v)) {
    const n = Number(v);
    if (Number.isSafeInteger(n)) return String(n);
    return v;
  }
  if (/^\d+\.0+$/.test(v)) return v.replace(/\.0+$/, '');
  return v;
}

/** @param {ArrayBuffer} buf  @returns {Promise<string[][]>} rows of the first sheet */
export async function readXlsx(buf) {
  const zip = readZipEntries(buf);
  const shared = [];
  const sst = await zip.text('xl/sharedStrings.xml');
  if (sst) {
    const re = /<si>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = re.exec(sst))) shared.push(textOf(m[1]));
  }
  // Resolve the first sheet in workbook order.
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const wb = await zip.text('xl/workbook.xml');
  const rels = await zip.text('xl/_rels/workbook.xml.rels');
  if (wb && rels) {
    const first = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb) || /<sheet\b[^>]*\bid="([^"]+)"/.exec(wb);
    if (first) {
      const rel = new RegExp(`<Relationship\\b[^>]*Id="${first[1]}"[^>]*>`).exec(rels);
      const target = rel && /Target="([^"]+)"/.exec(rel[0]);
      if (target) sheetPath = target[1].startsWith('/') ? target[1].slice(1) : 'xl/' + target[1].replace(/^\.\//, '');
    }
  }
  const sheet = await zip.text(sheetPath);
  if (!sheet) throw new Error('Could not find a worksheet in this .xlsx file.');
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(sheet))) {
    const row = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    let auto = 0;
    while ((cm = cellRe.exec(rm[1]))) {
      const attrs = cm[1];
      const inner = cm[2] || '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs);
      const idx = ref ? colIndex(ref[1]) : auto;
      auto = idx + 1;
      const t = (/\bt="([^"]+)"/.exec(attrs) || [])[1];
      const v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
      let val = '';
      if (t === 's') val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = textOf(inner);
      else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
      else if (t === 'str' || t === 'e') val = v !== undefined ? decodeXml(v) : '';
      else val = v !== undefined ? numberToString(v) : '';
      row[idx] = val;
    }
    for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = '';
    if (row.some((c) => String(c).trim() !== '')) rows.push(row);
  }
  return rows;
}
