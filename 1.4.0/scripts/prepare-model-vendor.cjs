'use strict'

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const project = path.resolve(__dirname, '..')
const vendor = path.join(project, 'bridge', 'vendor')
const requirements = path.join(project, 'bridge', 'model-requirements.txt')
// 3.10 keeps the original layout; AstrBot's 3.12 runtime gets its own complete graph.
const targets = [
  { python: '3.10', abi: 'cp310', directory: '' },
  { python: '3.12', abi: 'cp312', directory: 'cp312-win_amd64' }
]
const modules = ['pydantic_ai', 'pydantic_graph', 'pydantic', 'pydantic_core', 'openai', 'anthropic',
  'httpx2', 'httpcore2', 'anyio', 'genai_prices', 'griffe', 'logfire_api',
  'jiter', 'tiktoken', 'regex', 'requests', 'truststore', 'sniffio', 'docstring_parser',
  'annotated_types', 'certifi', 'charset_normalizer', 'h11', 'idna', 'urllib3']

function requiredFiles(target) {
  const suffix = `${target.abi}-win_amd64.pyd`
  return [
    ...modules.map(name => `${name}/__init__.py`),
    'typing_extensions.py', 'typing_inspection/introspection.py', 'typing_inspection/typing_objects.py',
    'opentelemetry/trace/__init__.py',
    'pydantic_ai_slim-2.51.0.dist-info/METADATA',
    `pydantic_core/_pydantic_core.${suffix}`, `jiter/jiter.${suffix}`,
    `tiktoken/_tiktoken.${suffix}`, `regex/_regex.${suffix}`,
    `charset_normalizer/cd.${suffix}`, `charset_normalizer/md.${suffix}`,
    ...(target.python === '3.10' ? ['exceptiongroup/__init__.py'] : [])
  ]
}

function targetComplete(root, target) {
  return requiredFiles(target).every(name => {
    try {
      const stat = fs.statSync(path.join(root, target.directory, name))
      return stat.isFile() && stat.size > 0
    } catch { return false }
  })
}

function complete(root = vendor) {
  return targets.every(target => targetComplete(root, target))
}

function prepare({ root = vendor, uv = process.env.ASTRWECHAT_UV || 'uv', run = spawnSync } = {}) {
  for (const target of targets) {
    if (!targetComplete(root, target)) {
      // Install into project-local, ABI-isolated directories, never the user's AstrBot Python.
      const result = run(uv, ['pip', 'install', '--target', path.join(root, target.directory),
        '--python-version', target.python, '--python-platform', 'x86_64-pc-windows-msvc',
        '--only-binary', ':all:', '--reinstall', '-r', requirements], { stdio: 'inherit', windowsHide: true })
      if (result.error || result.status !== 0 || !targetComplete(root, target)) {
        throw new Error(`Model dependencies for CPython ${target.python} are missing; install uv and retry build (${result.error?.message || result.status})`)
      }
    }
    console.log(`[model-vendor] CPython ${target.python} Windows x64 SDK ready`)
  }
}

if (require.main === module && process.platform === 'win32' && process.arch === 'x64') prepare()

module.exports = { complete, targetComplete, targets, requiredFiles, prepare }
