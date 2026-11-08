/**
 * Inline the UI dictionaries from `locale/*.json` into `client.js`.
 *
 * A browser half is one file the module loader evaluates as-is: it cannot read
 * a sibling JSON at runtime, and the Plugin Manager reads those same files for
 * this plugin's title and description. Keeping the copy generated from them
 * means the two never drift.
 *
 * Run from the package directory:  node scripts/embed-locale.mjs
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const BEGIN = '    // BEGIN GENERATED LOCALE'
const END = '    // END GENERATED LOCALE'

/**
 * Read one locale file and drop the plugin-manager metadata block, which the
 * page never renders itself.
 * @param locale - `zh` or `en`.
 * @returns the dictionary.
 */
async function readDictionary(locale) {
  const text = await readFile(join(root, 'locale', `${locale}.json`), 'utf8')
  const parsed = JSON.parse(text)
  const { meta, ...dictionary } = parsed
  void meta
  return dictionary
}

const zh = await readDictionary('zh')
const en = await readDictionary('en')

const block = [
  BEGIN + ' — written by scripts/embed-locale.mjs from locale/*.json',
  `    const zh = ${JSON.stringify(zh, null, 2).replace(/\n/g, '\n    ')}`,
  `    const en = ${JSON.stringify(en, null, 2).replace(/\n/g, '\n    ')}`,
  END,
].join('\n')

const clientPath = join(root, 'client.js')
const source = await readFile(clientPath, 'utf8')
const start = source.indexOf(BEGIN)
const stop = source.indexOf(END)
if (start < 0 || stop < 0 || stop < start) {
  throw new Error('client.js is missing the generated-locale markers')
}
const next = source.slice(0, start) + block + source.slice(stop + END.length)
await writeFile(clientPath, next, 'utf8')

const zhKeys = Object.keys(zh).sort()
const enKeys = Object.keys(en).sort()
const missingInEn = zhKeys.filter((key) => !enKeys.includes(key))
const missingInZh = enKeys.filter((key) => !zhKeys.includes(key))
if (missingInEn.length > 0) console.warn('en is missing:', missingInEn.join(', '))
if (missingInZh.length > 0) console.warn('zh is missing:', missingInZh.join(', '))

console.log(`embedded ${zhKeys.length} zh + ${enKeys.length} en entries into client.js`)
