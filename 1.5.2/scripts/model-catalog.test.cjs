const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText, filename)
const {fetchModelCatalog, parseModel} = require('../electron/services/modelCatalog.ts')
const {normalizeBridgeConnection, validateBridgeConnection, requiresBridgeRestart} = require('../shared/bridge-connection.ts')
const defaults = require('../shared/bridge-default-config.json')
const raw = {...defaults,bot_backend:'builtin',builtin_protocol:'chat_completions',builtin_base_url:'https://provider.example/v1',builtin_api_key:'private-test-key',builtin_model:'a'}
const json = body => new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}})
test('normalizes only explicitly supplied model capability fields',()=>{
  assert.deepEqual(parseModel({id:'a',top_provider:{context_length:64000,max_completion_tokens:4000},architecture:{input_modalities:['text','image']}}),{id:'a',name:'a',contextWindow:64000,maxInputTokens:null,maxOutputTokens:4000,vision:true})
  assert.deepEqual(parseModel({id:'claude-alias',display_name:'Alias',max_input_tokens:200000,max_tokens:64000,capabilities:{image_input:{supported:true}}}),{id:'claude-alias',name:'Alias',contextWindow:null,maxInputTokens:200000,maxOutputTokens:64000,vision:true})
  assert.equal(parseModel({id:'gpt-any',context_length:-1,max_output_tokens:'bad'}).contextWindow,null)
  assert.equal(parseModel({id:'gpt-any'}).vision,null)
  assert.equal(parseModel({id:'bad\nid'}),null)
})
test('OpenAI-compatible and Responses lists keep base prefixes and use bearer auth',async()=>{
  for(const protocol of ['chat_completions','responses']){
    const result=await fetchModelCatalog({...raw,builtin_protocol:protocol},async(url,opts)=>{
      assert.equal(url,'https://provider.example/v1/models');assert.equal(opts.headers.Authorization,'Bearer private-test-key');assert.equal(opts.redirect,'manual')
      return json({data:[{id:'b'},{id:'a'},{id:'a'},null]})
    })
    assert.deepEqual(result.models.map(x=>x.id),['a','b'])
  }
})
test('Anthropic version headers and bounded cursor pagination do not double v1',async()=>{
  for(const base of ['https://provider.example','https://provider.example/v1']){
    const seen=[]
    const result=await fetchModelCatalog({...raw,builtin_base_url:base,builtin_protocol:'anthropic_messages'},async(url,opts)=>{
      seen.push(url);assert.equal(opts.headers['x-api-key'],raw.builtin_api_key);assert.equal(opts.headers.Authorization,undefined);assert.equal(opts.headers['anthropic-version'],'2023-06-01')
      return json(seen.length===1?{data:[{id:'a'}],has_more:true,last_id:'a'}:{data:[{id:'b'}],has_more:false})
    })
    assert.equal(result.models.length,2);assert.deepEqual(seen,['https://provider.example/v1/models','https://provider.example/v1/models?after_id=a'])
  }
})
test('unsafe addresses are rejected before network; blank key and header injection rejected',async()=>{
  for(const base of ['http://outside.example/v1','file:///tmp','https://user:pass@example.com','https://provider.example/v1/chat/completions','https://provider.example?token=x']){
    const result=await fetchModelCatalog({...raw,builtin_base_url:base},()=>{throw Error('must not fetch')});assert.match(result.error,/E_MODELS_CONFIG/)
  }
  assert.match((await fetchModelCatalog({...raw,builtin_api_key:'a\nb'})).error,/E_MODELS_CONFIG/)
})
test('error bodies and thrown secrets never escape; redirects never followed',async()=>{
  for(const status of [301,401,403,404,429,500]){
    let calls=0
    const result=await fetchModelCatalog(raw,async()=>{calls++;return new Response('private-test-key user-private-message',{status,headers:{location:'https://other.example'}})})
    assert.equal(calls,1);assert.match(result.error,new RegExp(`E_MODELS_HTTP_${status}`));assert.doesNotMatch(result.error,/private-test-key|user-private-message/)
  }
  const result=await fetchModelCatalog(raw,async()=>{throw Error(raw.builtin_api_key)})
  assert.match(result.error,/E_MODELS_NETWORK/);assert.doesNotMatch(result.error,/private-test-key/)
})
test('invalid response, repeated cursors and oversized lists fail safely',async()=>{
  assert.match((await fetchModelCatalog(raw,async()=>json({message:'secret'}))).error,/E_MODELS_RESPONSE/)
  assert.match((await fetchModelCatalog(raw,async()=>new Response('not-json'))).error,/E_MODELS_RESPONSE/)
  assert.match((await fetchModelCatalog(raw,async()=>json({data:[{id:'a'}],has_more:true,last_id:'a'}))).error,/E_MODELS_PAGINATION/)
  assert.match((await fetchModelCatalog(raw,async()=>new Response(' '.repeat(8*1024*1024+1)))).error,/E_MODELS_TOO_LARGE/)
  const result=await fetchModelCatalog(raw,async()=>json({data:Array.from({length:2001},(_,i)=>({id:String(i)}))}))
  assert.equal(result.models.length,2000);assert.equal(result.truncated,true)
})
test('metadata is scoped to provider, protocol and exact model; configuration restart uses normalized defaults',()=>{
  const metadata={...parseModel({id:'a',context_length:4096}),baseUrl:raw.builtin_base_url,protocol:raw.builtin_protocol}
  assert.equal(normalizeBridgeConnection({...raw,builtin_model_metadata:metadata}).builtin_model_metadata.contextWindow,4096)
  for(const patch of [{builtin_model:'b'},{builtin_base_url:'https://other.example/v1'},{builtin_protocol:'responses'}]) assert.equal(normalizeBridgeConnection({...raw,...patch,builtin_model_metadata:metadata}).builtin_model_metadata,null)
  assert.equal(requiresBridgeRestart(raw,{...raw,builtin_segment_enabled:true}),true)
  assert.equal(requiresBridgeRestart({...raw,bot_backend:'astrbot'},{...raw,bot_backend:'astrbot',builtin_segment_enabled:true}),false)
  assert.equal(validateBridgeConnection({...raw,builtin_context_tokens:-1}).includes('上下文'),true)
  assert.equal(validateBridgeConnection({...raw,builtin_context_rounds:0}).includes('对话轮数'),true)
  assert.equal(requiresBridgeRestart(raw,{...raw,builtin_context_rounds:51}),true)
  assert.equal(validateBridgeConnection({...raw,builtin_segment_enabled:true,builtin_segment_random:'3,1'}).includes('间隔'),true)
  assert.equal(validateBridgeConnection({...raw,builtin_segment_enabled:true,builtin_segment_random:','}).includes('间隔'),true)
  assert.equal(validateBridgeConnection({...raw,builtin_segment_enabled:true}),null)
})
