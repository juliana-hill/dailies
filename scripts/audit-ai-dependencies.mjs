import { readFile, readdir } from 'node:fs/promises';
const prohibited = [/\bopenai\b/i, /\banthropic\b/i, /\blangchain\b/i, /\bcrewai\b/i, /\bbedrock\b/i, /@azure\/openai/i];
const files = ['package.json', 'package-lock.json'];
for (const file of files) { const text = await readFile(file, 'utf8'); const hit = prohibited.find((pattern) => pattern.test(text)); if (hit) { console.error(`Prohibited AI dependency reference ${hit} in ${file}`); process.exit(1); } }
console.log('AI dependency policy audit passed.');
