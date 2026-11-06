// 临时探针：验证 lib/mini-yaml.mjs 能否解析 profile 顶层「- id: xxx」序列块。
import { readFileSync } from 'node:fs'
import { parseMiniYaml } from './lib/mini-yaml.mjs'

const text = readFileSync('C:/Users/PC/.dsh/profiles/desktop/cordis.patch.yml', 'utf8')
const parsed = parseMiniYaml(text)
console.log('顶层类型:', Array.isArray(parsed) ? 'array' : typeof parsed)
console.log('块数:', Array.isArray(parsed) ? parsed.length : 'n/a')
for (const b of parsed) {
  console.log(' -', b && b.id, '| name =', b && b.name, '| config keys =', b && b.config ? Object.keys(b.config).join(',') : 'null')
}
const llm = parsed.find((b) => b && b.id === 'llm-pi-ai')
console.log('llm-pi-ai.providers =', JSON.stringify(llm.config.providers, null, 2))
const sales = parsed.find((b) => b && b.id === 'erp-sales-dashboard')
console.log('erp-sales-dashboard.config =', JSON.stringify(sales.config, null, 2))
