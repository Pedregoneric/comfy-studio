const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3030);
const HOST = process.env.HOST || '0.0.0.0';
let comfyUrl = (process.env.COMFY_URL || 'http://127.0.0.1:8188').replace(/\/$/, '');
let comfyRoot = process.env.COMFY_ROOT || '';
let llmUrl = (process.env.LLM_URL || '').replace(/\/$/, '');
let llmModel = process.env.LLM_MODEL || '';
let llmApiKey = process.env.LLM_API_KEY || '';
const PUBLIC = path.join(__dirname, 'public');
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');
const LIBRARY_FILE = path.join(__dirname, 'data', 'library.json');
const CHARACTER_CANON_FILE = path.join(__dirname, 'data', 'character-canon.json');
const allowed = new Set(['/system_stats', '/object_info', '/queue', '/history', '/prompt', '/interrupt', '/free']);

const types = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.gif':'image/gif', '.mp4':'video/mp4', '.webm':'video/webm' };

try {
  const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  if (saved.comfyUrl) comfyUrl = saved.comfyUrl;
  if (typeof saved.comfyRoot === 'string') comfyRoot = saved.comfyRoot;
  if (typeof saved.llmUrl === 'string') llmUrl = saved.llmUrl;
  if (typeof saved.llmModel === 'string') llmModel = saved.llmModel;
  if (typeof saved.llmApiKey === 'string' && saved.llmApiKey) llmApiKey = saved.llmApiKey;
} catch {}

function json(res, status, data) {
  res.writeHead(status, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' });
  res.end(JSON.stringify(data));
}

function readLibrary() { try { return { profiles:[], records:[], favorites:[], jobs:[], ...JSON.parse(fs.readFileSync(LIBRARY_FILE,'utf8')) }; } catch { return { profiles:[], records:[], favorites:[], jobs:[] }; } }
function writeLibrary(data) { fs.mkdirSync(path.dirname(LIBRARY_FILE),{recursive:true});fs.writeFileSync(LIBRARY_FILE,JSON.stringify(data,null,2)+'\n',{mode:0o600}); }
function addLibrary(collection,value) { const db=readLibrary(),entry={id:value.id||crypto.randomUUID(),created_at:value.created_at||new Date().toISOString(),...value};db[collection]=Array.isArray(db[collection])?db[collection]:[];db[collection].unshift(entry);db[collection]=db[collection].slice(0,collection==='records'||collection==='jobs'?500:200);writeLibrary(db);return entry; }
function updateLibrary(collection,id,value) { const db=readLibrary(),index=(db[collection]||[]).findIndex(x=>x.id===id);if(index<0)return null;db[collection][index]={...db[collection][index],...value,id,updated_at:new Date().toISOString()};writeLibrary(db);return db[collection][index]; }

async function proxy(req, res, targetPath) {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const upstream = await fetch(comfyUrl + targetPath, {
      method: req.method,
      headers: body ? { 'content-type': req.headers['content-type'] || 'application/json' } : {},
      body
    });
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
      'cache-control': 'no-store'
    });
    if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } catch (error) {
    json(res, 502, { error: 'Could not reach ComfyUI', detail: error.message, comfyUrl });
  }
}

async function readJson(req) {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function rootStatus() {
  if (!comfyRoot) return { configured:false, accessible:false, mode:'api' };
  try {
    const stat = fs.statSync(comfyRoot);
    const models = path.join(comfyRoot, 'models');
    const accessible = stat.isDirectory() && fs.statSync(models).isDirectory();
    const count = folder => {
      const root = path.join(models, folder); let total = 0;
      const visit = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes:true })) entry.isDirectory() ? visit(path.join(dir, entry.name)) : /\.(safetensors|ckpt|pt|pth|bin|gguf)$/i.test(entry.name) && total++; };
      try { visit(root); } catch {} return total;
    };
    return { configured:true, accessible, mode:accessible?'folder':'api', modelsPath:models, detected:{ checkpoints:count('checkpoints'), diffusionModels:count('diffusion_models'), loras:count('loras'), vaes:count('vae'), textEncoders:count('text_encoders') } };
  } catch { return { configured:true, accessible:false, mode:'api' }; }
}

async function comfyJson(route, options) {
  const response = await fetch(comfyUrl + route, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || data.error || `ComfyUI request failed (${response.status})`);
  return data;
}

function sanitizeNegativePrompt(positive, negative, loras = []) {
  const clean=s=>String(s||'').toLowerCase().replace(/<lora:[^>]+>/g,'').replace(/[_-]+/g,' ').replace(/\s+/g,' ').trim();
  const positiveParts=String(positive||'').replace(/<lora:[^>]+>/gi,'').split(/[,;\n]+/).map(clean).filter(Boolean);
  const triggers=(Array.isArray(loras)?loras:[]).flatMap(l=>String(l?.trigger||'').split(/[,;]+/)).map(clean).filter(Boolean);
  const requestedAdult=/\b(nsfw|nude|naked|topless|bottomless|explicit|sex|sexual acts?|penetration|oral|anal|masturbation|cum)\b/i.test(String(positive||''));
  const adultConflicts=new Set(['nsfw','nude','naked','topless','bottomless','explicit','sex','sexual act','sexual acts','penetration','oral','anal','masturbation','cum','fluid']);
  const requestedCounts=[...String(positive||'').toLowerCase().matchAll(/\b([2-9])\s*(girls?|boys?)\b/g)].map(m=>m[2].startsWith('girl')?'girls':'boys');
  const semanticPositive=String(positive||'').toLowerCase();
  const semanticConflict=part=>(part==='plain background'&&/\b(simple|plain|unobtrusive|minimal|clean) background\b/.test(semanticPositive))||(part==='closed eyes'&&/\beyes? (?:open|visible)\b/.test(semanticPositive));
  const conflictsPositive=part=>semanticConflict(part)||positiveParts.some(pos=>pos===part||new RegExp(`(?:^|\\s)${part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?:$|\\s)`).test(pos));
  const seen=new Set();
  return String(negative||'').replace(/<lora:[^>]+>/gi,'').split(/[,;\n]+/).map(x=>x.trim()).filter(Boolean).filter(item=>{
    const part=clean(item);if(!part||seen.has(part))return false;
    if(conflictsPositive(part)||triggers.some(trigger=>part===trigger||part.includes(trigger)))return false;
    if(requestedAdult&&adultConflicts.has(part))return false;
    if(requestedCounts.includes('girls')&&(part==='multiple girls'||/^\d+ girls?$/.test(part)))return false;
    if(requestedCounts.includes('boys')&&(part==='multiple boys'||/^\d+ boys?$/.test(part)))return false;
    seen.add(part);return true;
  }).slice(0,64).join(', ');
}

function inferLoraTrigger(filename, metadata = {}) {
  for(const key of ['modelspec.trigger_phrase','trigger_phrase','activation_text','ss_trigger_words'])if(String(metadata[key]||'').trim())return String(metadata[key]).split(/[,;\n]/)[0].trim();
  const generic=new Set(['1girl','1boy','solo','multiple girls','multiple boys','character name','looking at viewer','smile','long hair','short hair','breasts','large breasts','simple background','white background']);
  const counts=new Map(),add=(tag,count)=>{tag=String(tag||'').trim();if(tag&&!generic.has(tag.toLowerCase()))counts.set(tag,(counts.get(tag)||0)+Number(count||0))};
  const collect=value=>{try{const parsed=typeof value==='string'?JSON.parse(value):value;for(const dataset of Array.isArray(parsed)?parsed:[parsed])for(const frequencies of Object.values(dataset?.tag_frequency||{}))for(const [tag,count] of Object.entries(frequencies||{}))add(tag,count)}catch{}};
  collect(metadata.ss_datasets);collect(metadata.ss_tag_frequency);
  const file=String(filename||'').replace(/\.[^.]+$/,'').toLowerCase().replace(/[_-]+/g,' '),tokens=new Set(file.match(/[a-z0-9]+/g)||[]);
  const candidates=[...counts].filter(([tag])=>{const words=tag.toLowerCase().match(/[a-z0-9]+/g)||[];return words.length&&words.every(word=>tokens.has(word))}).sort((a,b)=>b[1]-a[1]||b[0].length-a[0].length);
  return candidates[0]?.[0]||'';
}

function promptDialectForModel(model = '') {
  const name=String(model).toLowerCase();
  if(/\bflux\b|flux[._-]?1/.test(name))return {id:'flux',label:'FLUX',format:'natural language'};
  if(/qwen|anima/.test(name))return {id:'qwen',label:'Qwen Image / Anima',format:'structured natural language'};
  if(/pony/.test(name))return {id:'pony',label:'Pony',format:'ordered booru tags'};
  if(/illustrious|noobai|noob[_ -]?ai|wai[-_ ]?nsfw|animagine/.test(name))return {id:'illustrious',label:'Illustrious / NoobAI / Animagine',format:'ordered Danbooru tags'};
  if(/sdxl|stable.?diffusion.?xl|juggernaut.?xl|realvis.?xl|dreamshaper.?xl/.test(name))return {id:'sdxl',label:'SDXL',format:'descriptive natural language'};
  if(/sd.?1[._-]?5|v1[._-]?5|stable.?diffusion.?1/.test(name))return {id:'sd15',label:'Stable Diffusion 1.5',format:'concise weighted tags'};
  return {id:'adaptive',label:'Unknown / custom model',format:'model-name-informed hybrid'};
}

function promptGuidanceForModel(model = '') {
  const dialect=promptDialectForModel(model);
  const shared='ComfyUI loads every supplied LoRA through a LoraLoader node. Put each non-empty activation trigger exactly once in the positive prompt, close to the subject or style it controls. Never emit <lora:name:weight> syntax, filenames, paths, or LoRA weights in either text prompt. Do not invent missing triggers. Keep multi-character attributes grouped per subject and use positional language when useful.';
  const guides={
    illustrious:'Write comma-separated Danbooru-style tags. Order them as subject count and identity; exact LoRA triggers; appearance and body; clothing; expression, pose and action; framing and camera; environment; lighting; style and finish. Use underscores only when they are part of an exact supplied trigger; otherwise use readable tags. Favor concrete tags over prose. Do not add score, rating, adult, or source tags unless the user explicitly requests them or the selected model name clearly requires that vocabulary. Keep the negative prompt as concise booru failure tags.',
    pony:'Write ordered comma-separated booru tags. Begin with model-appropriate quality score tags, then subject count and identity, exact LoRA triggers, appearance, clothing, expression/action, composition, environment, lighting, and style. Do not add rating or adult tags unless explicitly requested. Avoid long sentences and avoid contradictory quality vocabularies. Use a compact tag-based negative prompt.',
    sdxl:'Write coherent descriptive natural language in short clauses. Lead with the subject and defining identity, then action, scene, composition/lens, lighting, color, atmosphere, and finish. Use concrete visual language instead of keyword soup or repeated quality superlatives. Parenthesized emphasis may be used sparingly only for a genuinely critical feature. Write a short, specific negative prompt.',
    sd15:'Use concise comma-separated visual phrases because token budget and attribute binding are weaker. Put identity and exact triggers early; then essential appearance, action, framing, setting, lighting, and style. Remove filler and repetition. Use (concept:1.1) emphasis sparingly, never for LoRA weights. Keep the negative prompt compact and focused on likely anatomy, rendering, and composition failures.',
    flux:'Write one clear natural-language art-direction prompt, not booru tag soup. Establish subject and identity first, followed by action, setting, spatial composition, camera/lens, lighting, materials, color, mood, and style. Prefer positive descriptions of the desired result; FLUX variants may respond weakly to negatives, so keep negative_prompt minimal and only include essential exclusions.',
    qwen:'Write structured natural-language instructions with explicit subject, appearance, body proportions, clothing, pose/action, spatial relationships, setting, camera/framing, lighting, palette, and style. Use complete descriptive clauses and unambiguous placement language. Preserve exact triggers as literal tokens without turning the rest into tag soup. Keep the negative prompt short and concrete.',
    adaptive:'Infer the most likely syntax from the model filename and the requested medium. Use ordered booru tags for clearly anime/tag-trained models and structured natural language for photographic, instruction-following, or unknown diffusion models. Do not mix score-tag conventions from one ecosystem with another unless the filename supports them.'
  };
  return {...dialect,instructions:`Selected prompt dialect: ${dialect.label} (${dialect.format}). ${guides[dialect.id]} ${shared}`};
}

function matchCharacterCanon(idea, entries = []) {
  const haystack=String(idea||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  return (Array.isArray(entries)?entries:[]).filter(entry=>{
    const aliases=[entry?.name,...(Array.isArray(entry?.aliases)?entry.aliases:[])].filter(Boolean);
    return aliases.some(alias=>{
      const needle=String(alias).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
      return needle&&(` ${haystack} `).includes(` ${needle} `);
    });
  }).map(({aliases,...entry})=>entry).slice(0,6);
}

function localCharacterReferences(idea) {
  try{return matchCharacterCanon(idea,JSON.parse(fs.readFileSync(CHARACTER_CANON_FILE,'utf8')))}catch{return []}
}

async function resolveCharacterReferences(idea) {
  const known=localCharacterReferences(idea);
  const request={model:llmModel,temperature:0.1,max_tokens:900,messages:[
    {role:'system',content:'Extract established named fictional characters from an image idea and prepare a canonical visual identity brief. Return JSON only: {"characters":[{"name":"canonical name","series":"originating work","appearance":"hair, eyes, face, skin, signature nonhuman traits","body_proportions":"canonical height/build/silhouette stated neutrally","default_outfit":"specific canonical everyday outfit and colors","identity_exclusions":"likely wrong substitutions to prevent","style":"originating series visual style","confidence":"high|medium|low"}]}. Include only established public fictional characters, not generic people or private/custom characters. Separate canonical identity from scene invention. Never invent a tavern, bar, bedroom, school, historical costume, kimono, maid outfit, or other setting/outfit merely from a character name. Use the canonical default outfit unless the user explicitly requests another outfit. Do not add rating or adult-content tags. If unsure, use low confidence and leave uncertain details empty rather than guessing. Do not debate or add prose.'},
    {role:'user',content:JSON.stringify({idea,verified_private_overrides:known})}
  ]};
  if(/deepseek\.com/i.test(llmUrl)){request.thinking={type:'disabled'};request.response_format={type:'json_object'}}
  try{
    const response=await fetch(llmUrl+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',...(llmApiKey?{authorization:`Bearer ${llmApiKey}`}:{})},body:JSON.stringify(request)}),data=await response.json();
    if(!response.ok)throw new Error();
    const parsed=JSON.parse(String(data.choices?.[0]?.message?.content||'{}').replace(/^```(?:json)?\s*|\s*```$/g,'')),generated=Array.isArray(parsed.characters)?parsed.characters:[],knownNames=new Set(known.map(x=>String(x.name).toLowerCase()));
    return [...known,...generated.filter(x=>x&&x.name&&!knownNames.has(String(x.name).toLowerCase()))].slice(0,6);
  }catch{return known}
}

async function writeImagePrompts(idea, context = {}) {
  if (!llmUrl || !llmModel) throw new Error('Configure an LLM endpoint and model in Settings first');
  const promptGuide=promptGuidanceForModel(context.model);
  const characterReferences=await resolveCharacterReferences(idea);
  const completion = { model:llmModel, temperature:0.7, max_tokens:1200, messages:[
    { role:'system', content:'You are a production image-prompt compiler, not a conversational assistant. Return a matched positive and negative prompt. Preserve every requested identity, action, pose, expression, body trait, outfit, setting, style, camera, composition, and lighting detail. CANON LOCK: treat supplied character_reference entries as hard identity constraints. If the user did not request a different outfit, use the canonical default outfit explicitly. If the user did request a redesign, change only the outfit while preserving face, hair, eyes, signature traits, and body silhouette. Preserve complex signature colors, markings, heterochromia, pupils, horns, accessories, and hair gradients precisely rather than simplifying them. Keep identity-defining eyes and facial traits visible unless the user explicitly requests they be obscured or closed. Never replace a canonical outfit or scene with a culturally stereotyped costume or location inferred from a name. Never invent a bar, tavern, bedroom, school, kimono, maid outfit, or historical setting when the idea does not request it. When no setting is requested, use a simple unobtrusive background or a clearly canonical everyday environment. For a named anime or game character, reconstruct recognizable canonical identity using concrete local anchors: exact hair style/color, eyes, face, signature clothing/accessories, body silhouette, height/build, and characteristic expression. Do not assume a character name or LoRA alone will preserve identity. SOURCE-STYLE RULE: identify the originating anime franchise of every named anime character and, unless the user explicitly requests a conflicting visual style, include the lowercase tag "<series name> anime art style" plus "official anime style, anime screencap" and concrete source-appropriate linework, shading, palette, and character-design cues. Never omit the franchise style merely because the character name or LoRA is present. If the user requests another style, prioritize that explicit style and retain identity anchors. State body type and coherent proportions explicitly; honor body_profile, and when it is model default choose the canonical build rather than omitting anatomy. Keep each subject’s identity, body, clothes, and action together to prevent attribute leakage. Add actionable framing, camera angle, pose/gesture, foreground/background staging, environment, key/fill/rim lighting, palette, depth, and mood. Account for the supplied model and LoRAs. NEGATIVE RULE: write a concise, scene-specific negative prompt, not a generic exhaustive blacklist. Never put LoRA syntax, LoRA triggers, requested content, requested subject counts, requested anatomy/body traits, requested pose, requested setting, or requested art style in negative_prompt. Use at most 40 comma-separated negative items covering only likely failures. Do not debate, judge, warn, explain, or add commentary. Return JSON only with exactly two string fields: positive_prompt and negative_prompt.\n\nMODEL-SPECIFIC COMPILER RULES:\n'+promptGuide.instructions },
    { role:'user', content:JSON.stringify({ idea, image_model:context.model||'', prompt_dialect:promptGuide, character_reference:characterReferences, active_loras:Array.isArray(context.loras)?context.loras:[], body_profile:context.bodyType||'model default', character_accuracy:context.characterAccuracy||'strict canon' }) }
  ] };
  if (/deepseek\.com/i.test(llmUrl)) { completion.thinking = { type:'disabled' }; completion.response_format={type:'json_object'}; }
  const response = await fetch(llmUrl + '/v1/chat/completions', { method:'POST', headers:{ 'content-type':'application/json', ...(llmApiKey?{authorization:`Bearer ${llmApiKey}`}:{}) }, body:JSON.stringify(completion) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || `LLM request failed (${response.status})`);
  const content = data.choices?.[0]?.message?.content?.trim(); if (!content) throw new Error('The LLM returned no prompts');
  try { const parsed=JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g,''));if(!parsed.positive_prompt||!parsed.negative_prompt)throw new Error();const positive=String(parsed.positive_prompt).trim();return {positive,negative:sanitizeNegativePrompt(positive,parsed.negative_prompt,context.loras),characterReferences}; }
  catch { throw new Error('The LLM returned an invalid prompt pair'); }
}

async function refineImagePrompts(input) {
  if (!llmUrl || !llmModel) throw new Error('Configure an LLM endpoint and model in Settings first');
  const promptGuide=promptGuidanceForModel(input.model);
  const completion={model:llmModel,temperature:0.45,max_tokens:1400,messages:[
    {role:'system',content:'You are revising an image-generation prompt after the user reviewed its output. Return JSON only with exactly three string fields: positive_prompt, negative_prompt, and change_summary. Preserve every successful and uncriticized detail from the previous prompts. Apply every item of user feedback concretely using visible traits, pose, composition, camera, lighting, style, and identity anchors rather than vague quality words. Keep the negative prompt concise and scene-specific, never a generic blacklist. Never put LoRA syntax, LoRA triggers, requested content, subject counts, body traits, pose, setting, or art style in the negative prompt. Use at most 40 comma-separated negative items. Do not debate, warn, apologize, or explain outside change_summary. Preserve the selected model dialect while revising.\n\nMODEL-SPECIFIC COMPILER RULES:\n'+promptGuide.instructions},
    {role:'user',content:JSON.stringify({previous_positive_prompt:String(input.prompt||''),previous_negative_prompt:String(input.negative||''),user_feedback:String(input.feedback||''),image_model:String(input.model||''),prompt_dialect:promptGuide,active_loras:Array.isArray(input.loras)?input.loras:[]})}
  ]};
  if(/deepseek\.com/i.test(llmUrl)){completion.thinking={type:'disabled'};completion.response_format={type:'json_object'}}
  const response=await fetch(llmUrl+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',...(llmApiKey?{authorization:`Bearer ${llmApiKey}`}:{})},body:JSON.stringify(completion)}),data=await response.json();
  if(!response.ok)throw new Error(data.error?.message||`LLM request failed (${response.status})`);
  const content=data.choices?.[0]?.message?.content?.trim();if(!content)throw new Error('The LLM returned no revision');
  try{const parsed=JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g,''));if(!parsed.positive_prompt||!parsed.negative_prompt)throw new Error();const prompt=String(parsed.positive_prompt).trim();return {prompt,negative:sanitizeNegativePrompt(prompt,parsed.negative_prompt,input.loras),summary:String(parsed.change_summary||'Prompts revised from your feedback').trim()}}
  catch{throw new Error('The LLM returned an invalid prompt revision')}
}

async function selectGenerationAssets(idea, info) {
  const list=(node,key)=>info[node]?.input?.required?.[key]?.[0]||[],checkpoints=list('CheckpointLoaderSimple','ckpt_name'),diffusionModels=list('UNETLoader','unet_name'),loras=list('LoraLoader','lora_name');
  if(!llmUrl||!llmModel)return {model:checkpoints[0]||diffusionModels[0],loras:[],modelReason:'First available compatible model'};
  const request={model:llmModel,temperature:0.1,max_tokens:700,messages:[{role:'system',content:'Select installed image-generation assets for the request. Return JSON only: {"model":"exact installed filename","model_reason":"short reason","loras":[{"name":"exact installed filename","weight":number,"trigger":"known trigger or empty","kind":"character|style|subject","character":"full character name or empty","reason":"short reason"}]}. Choose the model whose name most strongly matches anime/illustration versus realistic intent and known character/style needs. Use zero LoRAs unless a filename is clearly relevant. STRICT IDENTITY RULE: select a character LoRA only when its filename matches the exact character requested; never use another character from the same franchise as a substitute. Set kind to character and character to the LoRA character’s full name for every character/identity LoRA. A franchise match is sufficient only for a general series style LoRA, which must have kind style and an empty character. Subject and visual-style LoRAs must directly match the request. When uncertain, select no LoRA. Never select a LoRA merely because it exists. Use at most 3 compatible LoRAs. Copy filenames exactly. Do not invent triggers; use an empty trigger unless it is evident from the filename.'},{role:'user',content:JSON.stringify({idea,checkpoints,diffusion_models:diffusionModels,loras})}]};
  if(/deepseek\.com/i.test(llmUrl)){request.thinking={type:'disabled'};request.response_format={type:'json_object'}}
  try{const response=await fetch(llmUrl+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',...(llmApiKey?{authorization:`Bearer ${llmApiKey}`}:{})},body:JSON.stringify(request)}),data=await response.json();if(!response.ok)throw new Error();const picked=JSON.parse(data.choices?.[0]?.message?.content||'{}'),all=[...checkpoints,...diffusionModels],ideaText=idea.toLowerCase();return {model:all.includes(picked.model)?picked.model:(checkpoints[0]||diffusionModels[0]),modelReason:String(picked.model_reason||'Best catalog match'),loras:Array.isArray(picked.loras)?picked.loras.filter(l=>{if(!loras.includes(l.name))return false;if(l.kind!=='character')return ['style','subject'].includes(l.kind);const words=String(l.character||'').toLowerCase().match(/[a-z0-9]+/g)||[];return words.length>0&&words.every(word=>ideaText.includes(word))}).slice(0,3).map(l=>({name:l.name,weight:Number.isFinite(Number(l.weight))?Number(l.weight):1,trigger:String(l.trigger||''),reason:String(l.reason||'Relevant to request')})):[]}}catch{return {model:checkpoints[0]||diffusionModels[0],loras:[],modelReason:'Automatic selection fallback'}}
}

function agentWorkflow(input, info) {
  const list = (node, key) => info[node]?.input?.required?.[key]?.[0] || [];
  const checkpoints = list('CheckpointLoaderSimple','ckpt_name'), diffusion = list('UNETLoader','unet_name'), loras = list('LoraLoader','lora_name');
  const requested = String(input.model || '');
  const find = (items, name) => items.find(x=>x===name) || items.find(x=>x.toLowerCase().includes(name.toLowerCase()));
  const diffusionName = requested ? find(diffusion, requested) : null;
  const modelName = diffusionName || (requested ? find(checkpoints, requested) : checkpoints[0]);
  if (!modelName) throw new Error(`Model not found: ${requested || '(default)'}`);
  const chosenLoras = Array.isArray(input.loras) ? input.loras.map(l=>({ name:find(loras,String(l.name||l)), weight:Number(l.weight ?? 1) })).filter(l=>l.name) : [];
  const seed = Number.isSafeInteger(Number(input.seed)) && Number(input.seed)>=0 ? Number(input.seed) : Math.floor(Math.random()*Number.MAX_SAFE_INTEGER);
  const width = Math.max(64,Math.round(Number(input.width)|| (diffusionName?832:1024))), height=Math.max(64,Math.round(Number(input.height)||(diffusionName?1216:1024))), steps=Math.max(1,Math.round(Number(input.steps)|| (diffusionName?25:28))), cfg=Number(input.cfg)||(diffusionName?7:7);
  if (!diffusionName) {
    const w={'1':{class_type:'CheckpointLoaderSimple',inputs:{ckpt_name:modelName}},'2':{class_type:'CLIPTextEncode',inputs:{text:input.prompt,clip:['1',1]}},'3':{class_type:'CLIPTextEncode',inputs:{text:input.negative||'blurry, low quality, distorted, deformed',clip:['1',1]}},'4':{class_type:'EmptyLatentImage',inputs:{width,height,batch_size:1}},'5':{class_type:'KSampler',inputs:{seed,steps,cfg,sampler_name:input.sampler||'dpmpp_2m',scheduler:input.scheduler||'karras',denoise:1,model:['1',0],positive:['2',0],negative:['3',0],latent_image:['4',0]}},'6':{class_type:'VAEDecode',inputs:{samples:['5',0],vae:['1',2]}},'7':{class_type:'SaveImage',inputs:{filename_prefix:'ComfyStudio_Agent',images:['6',0]}}};
    let model=['1',0],clip=['1',1],id=10;for(const l of chosenLoras){w[id]={class_type:'LoraLoader',inputs:{lora_name:l.name,strength_model:l.weight,strength_clip:l.weight,model,clip}};model=[String(id),0];clip=[String(id),1];id++}w['5'].inputs.model=model;w['2'].inputs.clip=clip;w['3'].inputs.clip=clip;return { workflow:w,model:modelName,seed };
  }
  const clips=list('CLIPLoader','clip_name'),vaes=list('VAELoader','vae_name');const clipName=find(clips,input.clip||(/anima/i.test(modelName)?'anima':'qwen'))||clips[0],vaeName=find(vaes,input.vae||'qwenimage')||vaes[0];
  if(!clipName||!vaeName)throw new Error('A text encoder and VAE are required for this diffusion model');
  const w={'1':{class_type:'UNETLoader',inputs:{unet_name:modelName,weight_dtype:'default'}},'2':{class_type:'CLIPLoader',inputs:{clip_name:clipName,type:'qwen_image'}},'3':{class_type:'VAELoader',inputs:{vae_name:vaeName}}};let model=['1',0],clip=['2',0],id=4;for(const l of chosenLoras){w[id]={class_type:'LoraLoader',inputs:{lora_name:l.name,strength_model:l.weight,strength_clip:l.weight,model,clip}};model=[String(id),0];clip=[String(id),1];id++}const pos=String(id++),neg=String(id++),latent=String(id++),sample=String(id++),decode=String(id++),save=String(id++);w[pos]={class_type:'TextEncodeQwenImageEdit',inputs:{clip,prompt:input.prompt}};w[neg]={class_type:'TextEncodeQwenImageEdit',inputs:{clip,prompt:input.negative||'blurry, low quality, distorted, deformed'}};w[latent]={class_type:'EmptySD3LatentImage',inputs:{width,height,batch_size:1}};w[sample]={class_type:'KSampler',inputs:{seed,steps,cfg,sampler_name:input.sampler||'er_sde',scheduler:input.scheduler||'normal',denoise:1,model,positive:[pos,0],negative:[neg,0],latent_image:[latent,0]}};w[decode]={class_type:'VAEDecode',inputs:{samples:[sample,0],vae:['3',0]}};w[save]={class_type:'SaveImage',inputs:{filename_prefix:'ComfyStudio_Agent',images:[decode,0]}};return { workflow:w,model:modelName,seed };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api/library' && req.method === 'GET') return json(res,200,readLibrary());
  const libraryMatch=url.pathname.match(/^\/api\/library\/(profiles|records|favorites|jobs)(?:\/([a-zA-Z0-9_-]+))?$/);
  if(libraryMatch){const [,collection,id]=libraryMatch;try{if(req.method==='GET')return json(res,200,id?(readLibrary()[collection]||[]).find(x=>x.id===id)||null:readLibrary()[collection]||[]);if(req.method==='POST')return json(res,201,addLibrary(collection,await readJson(req)));if(req.method==='PUT'&&id){const entry=updateLibrary(collection,id,await readJson(req));return json(res,entry?200:404,entry||{error:'Not found'});}if(req.method==='DELETE'&&id){const db=readLibrary();db[collection]=(db[collection]||[]).filter(x=>x.id!==id);writeLibrary(db);return json(res,200,{ok:true});}}catch(error){return json(res,400,{error:error.message})}}
  if(url.pathname==='/api/upload/image'&&req.method==='POST')return proxy(req,res,'/upload/image');
  if (url.pathname === '/api/config' && req.method === 'GET') return json(res, 200, { comfyUrl, comfyRoot, llmUrl, llmModel, hasLlmApiKey:Boolean(llmApiKey), rootStatus:rootStatus() });
  if(url.pathname==='/api/lora-trigger'&&req.method==='GET'){
    try{const filename=String(url.searchParams.get('filename')||'');if(!filename)throw new Error('LoRA filename is required');const info=await comfyJson('/object_info'),installed=info.LoraLoader?.input?.required?.lora_name?.[0]||[];if(!installed.includes(filename))return json(res,404,{error:'LoRA is not installed'});const metadata=await comfyJson('/view_metadata/loras?'+new URLSearchParams({filename}));return json(res,200,{trigger:inferLoraTrigger(filename,metadata),source:'embedded metadata'})}catch(error){return json(res,200,{trigger:'',source:'unavailable',detail:error.message})}
  }
  if (url.pathname === '/api/config' && req.method === 'PUT') {
    try {
      const next = await readJson(req);
      const parsed = new URL(String(next.comfyUrl || ''));
      if (!['http:','https:'].includes(parsed.protocol)) throw new Error('ComfyUI URL must use http or https');
      comfyUrl = parsed.toString().replace(/\/$/, '');
      comfyRoot = String(next.comfyRoot || '').trim();
      llmUrl = String(next.llmUrl || '').trim().replace(/\/$/, '');
      llmModel = String(next.llmModel || '').trim();
      if (typeof next.llmApiKey === 'string' && next.llmApiKey) llmApiKey = next.llmApiKey;
      if (next.clearLlmApiKey) llmApiKey = '';
      fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive:true });
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ comfyUrl, comfyRoot, llmUrl, llmModel, llmApiKey }, null, 2) + '\n', { mode:0o600 });
      return json(res, 200, { comfyUrl, comfyRoot, llmUrl, llmModel, hasLlmApiKey:Boolean(llmApiKey), rootStatus:rootStatus() });
    } catch (error) { return json(res, 400, { error:error.message }); }
  }
  if (url.pathname === '/api/llm/test' && req.method === 'POST') {
    try {
      if(!llmUrl||!llmModel)throw new Error('Configure an LLM endpoint and model first');
      const request={model:llmModel,temperature:0,max_tokens:8,messages:[{role:'user',content:'Reply with OK only.'}]};
      if(/deepseek\.com/i.test(llmUrl))request.thinking={type:'disabled'};
      const response=await fetch(llmUrl+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',...(llmApiKey?{authorization:`Bearer ${llmApiKey}`}:{})},body:JSON.stringify(request)}),data=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(data.error?.message||`Provider returned ${response.status}`);
      if(!data.choices?.[0]?.message)throw new Error('Provider returned an unexpected response');
      return json(res,200,{ok:true,model:llmModel,message:'Connection successful'});
    } catch(error){return json(res,502,{ok:false,error:error.message})}
  }
  if (url.pathname === '/api/prompt-writer' && req.method === 'POST') {
    try {
      const input = await readJson(req);
      const idea = String(input.idea || '').trim(); if (!idea) throw new Error('Enter an idea first');
      const suppliedLoras=Array.isArray(input.loras)?input.loras:[],needsModel=!input.model||input.model==='auto',needsLoras=!suppliedLoras.length;
      const automatic=(needsModel||needsLoras)?await selectGenerationAssets(idea,await comfyJson('/object_info')):{model:input.model,loras:suppliedLoras};
      const selectedModel=needsModel?automatic.model:input.model,selectedLoras=needsLoras?automatic.loras:suppliedLoras;
      const prompts=await writeImagePrompts(idea,{model:selectedModel,loras:selectedLoras,bodyType:input.bodyType,characterAccuracy:input.characterAccuracy}),dialect=promptDialectForModel(selectedModel);return json(res, 200, { prompt:prompts.positive, negative:prompts.negative, model:selectedModel, loras:selectedLoras, prompt_style:dialect, character_references:prompts.characterReferences, selection:{model_reason:needsModel?(automatic.modelReason||'Best catalog match'):'Manually selected',lora_reasons:selectedLoras.map(l=>({name:l.name,reason:l.reason||'Manually selected'}))} });
    } catch (error) { return json(res, 502, { error:error.message }); }
  }
  if (url.pathname === '/api/prompt-feedback' && req.method === 'POST') {
    try {
      const input=await readJson(req),feedback=String(input.feedback||'').trim();
      if(!feedback)throw new Error('Describe what should change first');
      if(!String(input.prompt||'').trim())throw new Error('The original prompt is missing');
      return json(res,200,await refineImagePrompts({...input,feedback}));
    } catch(error){return json(res,502,{error:error.message})}
  }
  if (url.pathname === '/api/agent/generate' && req.method === 'POST') {
    let agentJob;
    try {
      const input = await readJson(req), idea=String(input.idea||input.prompt||'').trim();if(!idea)throw new Error('idea or prompt is required');
      agentJob=addLibrary('jobs',{source:String(input.agent||'agent'),idea,status:'selecting assets'});
      const info=await comfyJson('/object_info'),automatic=await selectGenerationAssets(idea,info),selected={...input,model:input.model||automatic.model,loras:input.loras===undefined?automatic.loras:input.loras};
      const written=input.enhance===false?{positive:idea,negative:input.negative}:{...(await writeImagePrompts(idea,{model:selected.model,loras:selected.loras,bodyType:input.body_type,characterAccuracy:input.character_accuracy}))};const prompt=written.positive,negative=input.negative||written.negative;
      const built=agentWorkflow({...selected,prompt,negative},info),queued=await comfyJson('/prompt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:built.workflow,client_id:'comfy-studio-agent'})});updateLibrary('jobs',agentJob.id,{status:'generating',prompt_id:queued.prompt_id,model:built.model,loras:selected.loras,prompt,negative});
      const promptId=queued.prompt_id,deadline=Date.now()+Math.min(600000,Math.max(30000,Number(input.timeout_ms)||300000));let job;
      while(Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,1200));const history=await comfyJson('/history/'+promptId);if(history[promptId]){job=history[promptId];break}}
      if(!job)throw new Error('Generation timed out');
      if(job.status?.status_str==='error')throw new Error('ComfyUI generation failed');
      const files=[];for(const output of Object.values(job.outputs||{}))for(const kind of ['images','gifs','videos'])for(const file of output[kind]||[]){const query=new URLSearchParams({filename:file.filename,subfolder:file.subfolder||'',type:file.type||'output'});files.push({...file,kind,url:`${url.origin}/api/view?${query}`})}
      if(!files.length)throw new Error('Generation completed without media output');
      const result={prompt_id:promptId,prompt,negative,model:built.model,loras:selected.loras||[],seed:built.seed,outputs:files};updateLibrary('jobs',agentJob.id,{status:'complete',...result,completed_at:new Date().toISOString()});addLibrary('records',{source:'agent',...result,settings:{width:input.width,height:input.height,steps:input.steps,cfg:input.cfg,sampler:input.sampler,scheduler:input.scheduler}});return json(res,200,result);
    } catch(error){if(agentJob)updateLibrary('jobs',agentJob.id,{status:'error',error:error.message});return json(res,502,{error:error.message});}
  }
  if (url.pathname === '/api/view') return proxy(req, res, '/view' + url.search);
  if (url.pathname.startsWith('/api/comfy/')) {
    const targetPath = '/' + url.pathname.slice('/api/comfy/'.length);
    const isHistoryItem = /^\/history\/[a-zA-Z0-9_-]+$/.test(targetPath);
    if (!allowed.has(targetPath) && !isHistoryItem) return json(res, 404, { error: 'Unknown API route' });
    return proxy(req, res, targetPath + url.search);
  }
  if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed' });
  const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const file = path.resolve(PUBLIC, relative);
  if (!file.startsWith(PUBLIC + path.sep)) return json(res, 403, { error: 'Forbidden' });
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control':'no-cache' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
});

if(require.main===module)server.listen(PORT, HOST, () => {
  console.log(`Comfy Studio: http://${HOST}:${PORT}`);
  console.log(`ComfyUI: ${comfyUrl}`);
});

module.exports={sanitizeNegativePrompt,inferLoraTrigger,promptDialectForModel,promptGuidanceForModel,matchCharacterCanon};
