'use strict'

// Render the real React Bridge page in a hidden Electron window. All application IPC is
// stubbed: no WeChat connection, saved user configuration or external browser is touched.
const fs = require('node:fs')
const path = require('node:path')
const project = path.resolve(__dirname, '..')
const output = path.join(project, 'tmp', 'bridge-model-ui')

async function host() {
  const assert = require('node:assert/strict')
  const { app, BrowserWindow } = require('electron')
  app.setPath('userData', path.join(output, 'profile'))
  app.disableHardwareAcceleration()
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1120, height: 1080,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }))
  const evaluate = code => window.webContents.executeJavaScript(code, true)
  const pause = () => evaluate('new Promise(resolve => setTimeout(resolve, 80))')
  try {
    await window.loadFile(path.join(output, 'index.html'))
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await evaluate(`new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = () => {
        const configTab = Array.from(document.querySelectorAll('[role="tab"]')).find(e => e.textContent.includes('基础配置'));
        if (configTab) { configTab.click(); resolve(); }
        else if (Date.now() - started > 5000) reject(Error('Bridge page failed to mount'));
        else setTimeout(poll, 25);
      }; poll();
    })`)
    await evaluate(`new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = () => {
        const element = document.querySelector('#builtin-protocol');
        if (element && !element.matches(':disabled')) resolve();
        else if (Date.now() - started > 5000) reject(Error('Bridge configuration did not hydrate'));
        else setTimeout(poll, 25);
      }; poll();
    })`)
    const result = await evaluate(`(() => {
      const card = document.querySelector('[aria-label="内置模型配置"]');
      const heading = card.querySelector('.bridge-connection-group__heading');
      const link = heading.querySelector('a');
      const style = id => {
        const s = getComputedStyle(document.getElementById(id));
        return Object.fromEntries(['height','borderRadius','backgroundColor','borderColor','fontSize','paddingLeft'].map(k=>[k,s[k]]));
      };
      return { link: { href: link.href, text: link.textContent.trim(), title: link.title, target: link.target, rel: link.rel },
        badgeCount: heading.querySelectorAll('.slim-badge').length,
        protocol: style('builtin-protocol'), url: style('builtin-url'), key: style('builtin-key'),
        options: Array.from(document.querySelector('#builtin-protocol').options).map(o=>o.value) };
    })()`)
    assert.equal(result.link.href, 'https://hhapi.xyz/sign-up?aff=j6U0')
    assert.equal(result.link.text, '正在寻找合适的API服务？')
    assert.equal(result.link.title, '使用我的邀请码j6U0获得两元体验金')
    assert.equal(result.link.target, '_blank')
    assert.match(result.link.rel, /noopener/)
    assert.equal(result.badgeCount, 0)
    assert.deepEqual(result.protocol, result.key)
    assert.deepEqual(result.url, result.key)
    assert.deepEqual(result.options, ['chat_completions', 'responses', 'anthropic_messages'])
    await evaluate(`document.querySelector('[aria-label="内置模型配置"]').scrollIntoView({block:'start'})`)
    await pause()
    async function screenshot(name) {
      window.webContents.invalidate()
      await evaluate('new Promise(resolve => setTimeout(resolve, 220))')
      const rect = await evaluate(`(() => {const r=document.querySelector('[aria-label="内置模型配置"]').getBoundingClientRect(); return {x:Math.max(0,Math.floor(r.x)-4), y:Math.max(0,Math.floor(r.y)-4), width:Math.ceil(r.width)+8, height:Math.min(Math.ceil(r.height)+8, innerHeight-Math.max(0,Math.floor(r.y)-4))}})()`)
      fs.writeFileSync(path.join(output, name), (await window.webContents.capturePage(rect)).toPNG())
    }
    await screenshot('builtin-desktop.png')
    await evaluate(`document.querySelector('.bridge-api-service-link').click()`)
    await pause()
    assert.deepEqual(await evaluate('window.__ui.opened'), ['https://hhapi.xyz/sign-up?aff=j6U0'])
    assert.equal(await evaluate('location.protocol'), 'file:')
    assert.equal(await evaluate('window.__ui.saved.length'), 0)
    await evaluate(`document.querySelector('.bridge-api-service-link').dispatchEvent(new MouseEvent('auxclick', {button:1, bubbles:true, cancelable:true}))`)
    await pause()
    assert.equal(await evaluate('window.__ui.opened.length'), 2)
    await evaluate(`window.__ui.openMode='reject'; document.querySelector('.bridge-api-service-link').click()`)
    await pause()
    assert.equal(await evaluate(`document.querySelector('[aria-label="内置模型配置"] [role="alert"]').textContent`), '无法打开浏览器，请稍后重试。')
    await evaluate(`window.__ui.openMode='false'; document.querySelector('.bridge-api-service-link').click()`)
    await pause()
    assert.equal(await evaluate(`document.querySelector('[aria-label="内置模型配置"] [role="alert"]').textContent`), '无法打开浏览器，请稍后重试。')
    await evaluate(`window.__ui.openMode='ok'; document.querySelector('.bridge-api-service-link').click()`)
    await pause()
    assert.equal(await evaluate(`document.querySelector('[aria-label="内置模型配置"] [role="alert"]')`), null)
    const openedBeforeKeyboard = await evaluate('window.__ui.opened.length')
    await evaluate(`document.querySelector('.bridge-api-service-link').focus()`)
    window.webContents.sendInputEvent({type:'keyDown', keyCode:'Return'})
    window.webContents.sendInputEvent({type:'keyUp', keyCode:'Return'})
    await pause()
    assert.equal(await evaluate('window.__ui.opened.length'), openedBeforeKeyboard + 1)
    await evaluate(`document.getElementById('builtin-protocol').value='anthropic_messages'; document.getElementById('builtin-protocol').dispatchEvent(new Event('change',{bubbles:true}))`)
    await pause()
    assert.equal(await evaluate(`document.getElementById('builtin-url').value`), 'https://api.anthropic.com')
    await evaluate(`const url=document.getElementById('builtin-url'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(url,'https://custom.example/v1'); url.dispatchEvent(new Event('input',{bubbles:true}))`)
    await pause()
    await evaluate(`document.getElementById('builtin-protocol').value='responses'; document.getElementById('builtin-protocol').dispatchEvent(new Event('change',{bubbles:true}))`)
    await pause()
    assert.equal(await evaluate(`document.getElementById('builtin-url').value`), 'https://custom.example/v1')
    await evaluate(`document.getElementById('builtin-url').focus()`)
    await pause()
    const urlFocus = await evaluate(`getComputedStyle(document.getElementById('builtin-url')).boxShadow`)
    await pause()
    await evaluate(`document.getElementById('builtin-protocol').focus()`)
    await pause()
    assert.notEqual(await evaluate(`getComputedStyle(document.getElementById('builtin-protocol')).boxShadow`), 'none')
    await evaluate(`document.getElementById('builtin-fetch-models').click()`)
    await pause()
    assert.match(await evaluate(`document.getElementById('builtin-model-capabilities').textContent`), /64,000/)
    assert.equal(await evaluate(`document.getElementById('builtin-model-list').options.length`), 3)
    await evaluate(`document.getElementById('builtin-model-list').value='small';document.getElementById('builtin-model-list').dispatchEvent(new Event('change',{bubbles:true}))`)
    await pause()
    assert.equal(await evaluate(`document.getElementById('builtin-model').value`), 'small')
    assert.match(await evaluate(`document.getElementById('builtin-model-capabilities').textContent`), /输出上限：512/)
    assert.doesNotMatch(await evaluate(`document.querySelector('.bridge-model-catalog').textContent`), /当前上下文预算|实际最大输出|自动优先使用上游元数据|UTF-8 字节保守估算/)
    assert.equal(await evaluate(`document.getElementById('builtin-context-rounds').value`), '50')
    assert.equal(await evaluate(`document.getElementById('builtin-output-tokens').value`), '2048')
    assert.equal(await evaluate(`document.getElementById('builtin-segment-random').disabled`), true)
    await evaluate(`document.getElementById('builtin-segment-enabled').click()`)
    await pause()
    assert.equal(await evaluate(`document.getElementById('builtin-segment-random').disabled`), false)
    assert.equal(await evaluate(`document.getElementById('builtin-segment-threshold').value`), '150')
    await evaluate(`document.getElementById('builtin-segment-interval').value='log';document.getElementById('builtin-segment-interval').dispatchEvent(new Event('change',{bubbles:true}))`)
    await pause()
    assert.equal(await evaluate(`document.getElementById('builtin-segment-base').value`), '2')
    assert.equal(await evaluate(`document.getElementById('builtin-segment-random').disabled`), true)
    await evaluate(`document.querySelector('.bridge-model-catalog').scrollIntoView({block:'start'})`)
    await pause()
    await screenshot('builtin-model-catalog.png')
    await evaluate(`document.querySelector('.bridge-segment-options').scrollIntoView({block:'start'})`)
    await pause()
    await screenshot('builtin-segments.png')
    await evaluate(`window.__ui.modelMode='fail';document.getElementById('builtin-fetch-models').click()`)
    await pause()
    assert.match(await evaluate(`document.querySelector('.bridge-model-catalog [role="alert"]').textContent`), /E_MODELS_HTTP_401/)
    await evaluate(`window.__ui.modelMode='defer';document.getElementById('builtin-fetch-models').click()`)
    await pause()
    await evaluate(`const field=document.getElementById('builtin-url');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,'https://another.example/v1');field.dispatchEvent(new Event('input',{bubbles:true}))`)
    await pause()
    await evaluate(`window.__ui.resolveModels({success:true,models:[{id:'stale',name:'Stale',contextWindow:100000,maxInputTokens:null,maxOutputTokens:null,vision:null}]})`)
    await pause()
    assert.equal(await evaluate(`document.getElementById('builtin-model-list')`),null)
    assert.doesNotMatch(await evaluate(`document.getElementById('builtin-model-capabilities').textContent`), /8,192|100,000/)
    assert.equal(await evaluate(`window.__ui.saved.length`),0)
    // Render the narrow-width layout and confirm the heading/link does not overflow.
    window.setContentSize(420, 1100)
    await pause()
    await evaluate(`document.querySelector('[aria-label="内置模型配置"]').scrollIntoView({block:'start'})`)
    await pause()
    const mobile = await evaluate(`(() => {const card=document.querySelector('[aria-label="内置模型配置"]');const link=card.querySelector('a');const r=card.getBoundingClientRect(),l=link.getBoundingClientRect();return {left:l.left,right:l.right,cardLeft:r.left,cardRight:r.right,width:innerWidth}})()`)
    assert.ok(mobile.left >= mobile.cardLeft && mobile.right <= mobile.cardRight && mobile.cardRight <= mobile.width)
    await screenshot('builtin-mobile.png')
    await evaluate(`document.querySelector('.bridge-segment-options').scrollIntoView({block:'start'})`)
    await pause()
    await screenshot('builtin-segments-mobile.png')
    window.setContentSize(1120, 1080)
    await evaluate(`Array.from(document.querySelectorAll('[role="tab"]')).find(e=>e.textContent.includes('概览')).click()`)
    await pause()
    const workflowItems = () => evaluate(`Array.from(document.querySelectorAll('.bridge-workflow__item')).map(e=>({label:e.querySelector('strong').textContent,detail:e.querySelector('em').textContent}))`)
    assert.deepEqual(await workflowItems(), [], 'hydrated 500-line history must not replay')
    const emitLog = async line => { await evaluate(`window.__ui.emitLog(${JSON.stringify(line)})`); await pause() }
    for (const line of ['[INFO] [内置模型] 已就绪', '[INFO] 内置模型已入队：测试 群', '[INFO] [内置模型] 正在请求模型 [群|测试 群]', '[INFO] [内置模型] 已收到模型回复 [群|测试 群]', '[INFO] [UIA✓] 测试 群: 你好...']) await emitLog(line)
    assert.deepEqual((await workflowItems()).map(item=>item.label), ['请求内置模型','模型回复已生成','UIA 发送消息'])
    await emitLog('[INFO] 📩 群消息 [测试 群]: hello')
    assert.equal((await workflowItems()).length,3,'raw group receipt must not duplicate the buffered workflow event')
    await emitLog('[INFO] 📩 收到来自 测试 群 的消息，等待 2s 后统一推送')
    assert.equal((await workflowItems()).filter(item=>item.label==='接收微信消息').length,1)
    await evaluate(`document.querySelector('.bridge-workflow').scrollIntoView({block:'center'})`)
    await pause()
    await evaluate('new Promise(resolve=>setTimeout(resolve,450))')
    await evaluate(`document.querySelector('.bridge-workflow__stage').scrollTo({top:0,behavior:'instant'})`)
    const workRect=await evaluate(`(() => {const r=document.querySelector('.bridge-workflow').getBoundingClientRect();return {x:Math.max(0,Math.floor(r.x)-4),y:Math.max(0,Math.floor(r.y)-4),width:Math.ceil(r.width)+8,height:Math.ceil(r.height)+8}})()`)
    fs.writeFileSync(path.join(output,'builtin-workflow.png'),(await window.webContents.capturePage(workRect)).toPNG())
    const beforeDuplicate = await workflowItems()
    await emitLog('[INFO] [OB11] 文字已发送至 测试 群: 你好')
    assert.deepEqual(await workflowItems(), beforeDuplicate, 'OB11 duplicate must not add another success')
    await emitLog('[INFO] [UIA✓] 测试 群: 你好...')
    assert.equal((await workflowItems()).filter(item=>item.label==='UIA 发送消息').length,2,'identical real sends both appear even after 500 logs')
    await emitLog('[INFO] [UIA✓] 图片 → 测试 群: image.png')
    assert.equal((await workflowItems()).at(-1).label,'发送图片')
    await emitLog('[WARNING] [E_MODEL_AUTH] 模型鉴权失败。 异常类型：AuthenticationError')
    assert.equal((await workflowItems()).at(-1).label,'内置模型处理异常')
    await emitLog('[INFO] [内置模型] 本次回复已取消 [私|测试 联系人]')
    assert.equal((await workflowItems()).at(-1).label,'内置模型回复已取消')
    await evaluate(`Array.from(document.querySelectorAll('[role="tab"]')).find(e=>e.textContent.includes('日志')).click()`)
    await pause()
    assert.equal(await evaluate(`document.querySelector('.bridge-log-panel').textContent.includes('正在请求模型')`),true)
    await evaluate(`Array.from(document.querySelectorAll('.bridge-log-toolbar button')).find(e=>e.textContent.includes('清空')).click()`)
    await pause()
    assert.deepEqual(await workflowItems(),[])
    await emitLog('[INFO] [UIA✓] 测试 群: 清空之后...')
    assert.equal((await workflowItems()).length,1)
    await evaluate(`window.__ui.remount()`)
    await pause()
    await pause()
    assert.deepEqual(await workflowItems(),[],'returning to route must not replay old logs')
    await emitLog('[INFO] [内置模型] 正在请求模型 [私|重新进入]')
    assert.equal((await workflowItems()).at(-1).detail,'重新进入')
    await evaluate(`new Promise(resolve=>setTimeout(resolve,7900))`)
    assert.deepEqual(await workflowItems(),[],'workflow items expire normally')
    console.log(JSON.stringify({ passed: true, workflowPassed: true, ...result, mobile, urlFocus, screenshots: [path.join(output, 'builtin-desktop.png'),path.join(output, 'builtin-mobile.png'),path.join(output,'builtin-workflow.png')] }, null, 2))
    window.destroy()
    app.exit(0)
  } catch (error) {
    console.error(error)
    window.destroy()
    app.exit(1)
  }
}

async function buildAndRun() {
  fs.mkdirSync(output, { recursive: true })
  const defaults = require('../shared/bridge-default-config.json')
  const entry = `import React from 'react'; import {createRoot} from 'react-dom/client';
    import BridgePage from '../../src/slim/pages/BridgePage';
    const config={...${JSON.stringify(defaults)},bot_backend:'builtin',builtin_api_key:'test-key',builtin_model:'test-model'};
    const status={running:true,paused:false,ob_connected:true,processRunning:true,bot_backend:'builtin'};
    window.__ui={opened:[],saved:[],openMode:'ok',modelMode:'ok',modelCalls:[],initialLogs:Array.from({length:500},(_,i)=>'[INFO] [UIA✓] 历史会话: history-'+i+'...')};
    window.electronAPI={bridge:{getModels:async cfg=>{window.__ui.modelCalls.push(cfg);if(window.__ui.modelMode==='defer')return new Promise(resolve=>{window.__ui.resolveModels=resolve});if(window.__ui.modelMode==='fail')return {success:false,error:'[E_MODELS_HTTP_401] 鉴权失败'};return {success:true,models:[{id:'small',name:'Small',contextWindow:8192,maxInputTokens:null,maxOutputTokens:512,vision:false},{id:'test-model',name:'Test Model',contextWindow:64000,maxInputTokens:60000,maxOutputTokens:4096,vision:true}]}} ,status:async()=>status,getLogs:async()=>window.__ui.initialLogs,getConfig:async()=>({success:true,config}),
      onLog:callback=>{window.__ui.emitLog=callback;return ()=>{window.__ui.emitLog=null}},onStatus:()=>()=>{},saveConfig:async value=>{window.__ui.saved.push(value);return {success:true}},
      start:async()=>({success:true}),stop:async()=>({success:true}),clearLogs:async()=>{}},
      chat:{getSessions:async()=>({success:true,sessions:[]}),onWcdbChange:()=>()=>{}},
      shell:{openExternal:async url=>{window.__ui.opened.push(url);if(window.__ui.openMode==='reject')throw Error('test rejection');return {success:window.__ui.openMode!=='false'}}}};
    const root=createRoot(document.getElementById('root'));let mountKey=0;window.__ui.remount=()=>root.render(<BridgePage key={++mountKey}/>);root.render(<BridgePage key={mountKey}/>);`
  const entryPath = path.join(output, 'entry.tsx')
  fs.writeFileSync(entryPath, entry)
  await require('esbuild').build({ entryPoints: [entryPath], bundle: true, outfile: path.join(output, 'ui.js'),
    platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'scss', setup(build) { build.onLoad({filter:/\.scss$/}, args => ({ contents: require('sass').compile(args.path, {style:'expanded'}).css, loader:'css', resolveDir:path.dirname(args.path) })) } }] })
  fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="ui.css"><style>body{margin:0;padding:24px;font-family:"Segoe UI","Microsoft YaHei",sans-serif;background:#fafafa;box-sizing:border-box}*{box-sizing:border-box}</style></head><body><div id="root"></div><script src="ui.js"></script></body></html>')
  const env = {...process.env}
  delete env.ELECTRON_RUN_AS_NODE
  const result = require('node:child_process').spawnSync(require('electron'), [__filename, '--ui-host'],
    { cwd: project, env, windowsHide: true, encoding: 'utf8', timeout: 60000 })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Bridge UI regression failed: ${result.status}`)
}

if (process.argv.includes('--ui-host')) host().catch(error => { console.error(error); require('electron').app.exit(1) })
else buildAndRun().catch(error => { console.error(error); process.exitCode=1 })
