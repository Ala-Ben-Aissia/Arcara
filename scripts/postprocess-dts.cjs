const fs = require('fs');
const p = 'dist/index.d.ts';
try {
  let s = fs.readFileSync(p, 'utf8');
  const header = '/// <reference types="node" />\n';
  if (!s.startsWith(header)) fs.writeFileSync(p, header + s);
} catch (e) {
  console.error('postprocess-dts failed:', e && e.message ? e.message : e);
  process.exit(1);
}
