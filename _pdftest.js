const fs = require('fs');
const pdfParse = require('pdf-parse');

const f = 'C:/Users/Sum/Desktop/Appointment/Appointment_06-10-2026.pdf';
const buf = fs.readFileSync(f);
pdfParse(buf).then(data => {
  const txt = data.text;
  console.log('=== LENGTH', txt.length, '===');
  // show first 60 lines
  const lines = txt.split('\n');
  console.log('LINE COUNT', lines.length);
  console.log('--- first 80 lines ---');
  console.log(lines.slice(0, 80).join('\n'));
  // check regexes
  const cnum = (txt.match(/\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\s+(\d{3,5})/g) || []);
  console.log('--- contract slot matches ---', cnum.length);
  console.log(cnum.slice(0, 10).join(' | '));
  const blockHdr = (txt.match(/^\d{2}$/gm) || []);
  console.log('--- 2-digit block headers ---', blockHdr.length);
}).catch(e => { console.error('ERR', e); process.exit(1); });
