const $ = s => document.querySelector(s);
const state = { objectInfo:{}, checkpoints:[], diffusionModels:[], loras:[], outputs:[], active:null, poll:null, pending:{}, referenceName:'', assetSelection:null, customWorkflow:null };
const els = { model:$('#model'), clipModel:$('#clipModel'), vaeModel:$('#vaeModel'), loras:$('#loras'), positive:$('#positive'), negative:$('#negative'), width:$('#width'), height:$('#height'), steps:$('#steps'), cfg:$('#cfg'), sampler:$('#sampler'), scheduler:$('#scheduler'), seed:$('#seed'), generate:$('#generate'), preview:$('#preview'), video:$('#videoPreview'), stage:$('#stage'), progress:$('#progress'), gallery:$('#gallery'), recent:$('#recent'), presets:$('#presets'), status:$('#jobStatus') };

function toast(message){const t=$('#toast');t.textContent=message;t.classList.add('show');clearTimeout(t.timer);t.timer=setTimeout(()=>t.classList.remove('show'),2600)}
async function api(path, options){const r=await fetch('/api/comfy'+path,options);const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.detail||data.error||`Request failed (${r.status})`);return data}
function choices(node,input){return node?.input?.required?.[input]?.[0]||[]}
function fill(select, values, fallback){select.innerHTML='';(values.length?values:fallback||[]).forEach(v=>select.add(new Option(v,v)))}

async function connect(){
  try{
    state.objectInfo=await api('/object_info');
    state.checkpoints=choices(state.objectInfo.CheckpointLoaderSimple,'ckpt_name');
    state.diffusionModels=choices(state.objectInfo.UNETLoader,'unet_name');
    state.loras=choices(state.objectInfo.LoraLoader,'lora_name');
    els.model.innerHTML='';
    els.model.add(new Option('Auto-select for prompt','auto::'));
    const cg=document.createElement('optgroup');cg.label=`Checkpoints (${state.checkpoints.length})`;state.checkpoints.forEach(n=>cg.append(new Option(n,`checkpoint::${n}`)));els.model.append(cg);
    if(state.diffusionModels.length){const dg=document.createElement('optgroup');dg.label=`Diffusion models (${state.diffusionModels.length})`;state.diffusionModels.forEach(n=>dg.append(new Option(n,`diffusion::${n}`)));els.model.append(dg)}
    fill(els.clipModel,choices(state.objectInfo.CLIPLoader,'clip_name'),[]);
    fill(els.vaeModel,choices(state.objectInfo.VAELoader,'vae_name'),[]);
    fill(els.sampler,choices(state.objectInfo.KSampler,'sampler_name'),['euler','dpmpp_2m']);
    fill(els.scheduler,choices(state.objectInfo.KSampler,'scheduler'),['normal','karras']);
    if([...els.sampler.options].some(o=>o.value==='dpmpp_2m'))els.sampler.value='dpmpp_2m';
    if([...els.scheduler.options].some(o=>o.value==='karras'))els.scheduler.value='karras';
    $('#connection').className='connection online';$('#connection span').textContent='ComfyUI online';
    $('#inventory').innerHTML=`<span>${state.checkpoints.length} checkpoints</span><span>${state.diffusionModels.length} diffusion models</span><span>${state.loras.length} LoRAs</span><span>${choices(state.objectInfo.VAELoader,'vae_name').length} VAEs</span>`;
    await loadHistory();
  }catch(e){$('#connection').className='connection offline';$('#connection span').textContent='ComfyUI offline';els.model.innerHTML='<option>Unavailable</option>';toast(e.message)}
}

function addLora(data={}){
  if(!state.loras.length)return toast('No LoRAs reported by ComfyUI');
  els.loras.querySelector('.empty-note')?.remove();
  const row=document.createElement('div');row.className='lora-row';
  const select=document.createElement('select');fill(select,state.loras);if(data.name)select.value=data.name;
  const trigger=document.createElement('input');trigger.className='lora-trigger';trigger.type='text';trigger.placeholder='Trigger words';trigger.value=data.trigger||'';trigger.title='Optional LoRA activation words';
  const weight=document.createElement('input');weight.type='number';weight.step='.05';weight.value=data.weight??1;weight.title='Strength';
  const remove=document.createElement('button');remove.textContent='×';remove.title='Remove';remove.onclick=()=>{row.remove();if(!els.loras.children.length)els.loras.innerHTML='<div class="empty-note">No LoRAs added</div>'};
  row.append(select,trigger,weight,remove);els.loras.append(row);
  const detect=async()=>{if(trigger.value.trim())return trigger.value.trim();trigger.placeholder='Detecting trigger…';try{const r=await fetch('/api/lora-trigger?'+new URLSearchParams({filename:select.value})),d=await r.json();if(d.trigger&&!trigger.value.trim()){trigger.value=d.trigger;trigger.title='Automatically detected from embedded LoRA metadata';toast(`Detected trigger: ${d.trigger}`)}return trigger.value.trim()}catch{return ''}finally{trigger.placeholder='Trigger words'}};
  row.detectTrigger=detect;select.addEventListener('change',()=>{trigger.value='';detect()});if(!data.trigger)detect();
}

async function resolveLoraTriggers(){await Promise.all([...els.loras.querySelectorAll('.lora-row')].map(row=>row.detectTrigger?.()));return values().loras}

function values(){const [modelType,modelName]=els.model.value.includes('::')?els.model.value.split(/::(.+)/):['checkpoint',els.model.value];return {model:els.model.value,modelType,modelName,clipModel:els.clipModel.value,vaeModel:els.vaeModel.value,positive:els.positive.value,negative:els.negative.value,width:+els.width.value,height:+els.height.value,steps:+els.steps.value,cfg:+els.cfg.value,sampler:els.sampler.value,scheduler:els.scheduler.value,seed:+els.seed.value,workflow:$('#workflowType').value,referenceName:state.referenceName,denoise:+$('#denoise').value,batchCount:+$('#batchCount').value,priority:$('#priorityQueue').checked,assetSelection:state.assetSelection,loras:[...els.loras.querySelectorAll('.lora-row')].map(r=>({name:r.children[0].value,trigger:r.children[1].value.trim(),weight:+r.children[2].value}))}}
function apply(v){['positive','negative','width','height','steps','cfg','sampler','scheduler','seed','clipModel','vaeModel'].forEach(k=>{if(v[k]!==undefined&&els[k])els[k].value=v[k]});if(v.model!==undefined)els.model.value=v.model.includes('::')?v.model:`checkpoint::${v.model}`;if(v.workflow){$('#workflowType').value=v.workflow;$('#workflowType').dispatchEvent(new Event('change'))}if(v.denoise!==undefined)$('#denoise').value=v.denoise;if(v.batchCount!==undefined)$('#batchCount').value=v.batchCount;state.assetSelection=v.assetSelection||null;modelChanged(false);els.loras.innerHTML='<div class="empty-note">No LoRAs added</div>';(v.loras||[]).forEach(addLora)}

function workflow(v){
  if(v.workflow==='custom')return structuredClone(state.customWorkflow);
  if(v.modelType==='diffusion')return diffusionWorkflow(v);
  const w={
    '1':{class_type:'CheckpointLoaderSimple',inputs:{ckpt_name:v.modelName}},
    '2':{class_type:'CLIPTextEncode',inputs:{text:v.positive,clip:['1',1]}},
    '3':{class_type:'CLIPTextEncode',inputs:{text:v.negative,clip:['1',1]}},
    '4':{class_type:'EmptyLatentImage',inputs:{width:v.width,height:v.height,batch_size:1}},
    '5':{class_type:'KSampler',inputs:{seed:v.seed<0?Math.floor(Math.random()*Number.MAX_SAFE_INTEGER):v.seed,steps:v.steps,cfg:v.cfg,sampler_name:v.sampler,scheduler:v.scheduler,denoise:1,model:['1',0],positive:['2',0],negative:['3',0],latent_image:['4',0]}},
    '6':{class_type:'VAEDecode',inputs:{samples:['5',0],vae:['1',2]}},
    '7':{class_type:'SaveImage',inputs:{filename_prefix:'ComfyStudio',images:['6',0]}}
  };
  let model=['1',0],clip=['1',1],id=10;
  v.loras.forEach(l=>{w[id]={class_type:'LoraLoader',inputs:{lora_name:l.name,strength_model:l.weight,strength_clip:l.weight,model,clip}};model=[String(id),0];clip=[String(id),1];id++});
  w['5'].inputs.model=model;w['2'].inputs.clip=clip;w['3'].inputs.clip=clip;
  if(['img2img','inpaint'].includes(v.workflow)&&v.referenceName){w['8']={class_type:'LoadImage',inputs:{image:v.referenceName}};w['9']=v.workflow==='inpaint'?{class_type:'VAEEncodeForInpaint',inputs:{pixels:['8',0],vae:['1',2],mask:['8',1],grow_mask_by:6}}:{class_type:'VAEEncode',inputs:{pixels:['8',0],vae:['1',2]}};w['5'].inputs.latent_image=['9',0];w['5'].inputs.denoise=v.denoise}
  if(v.workflow==='upscale'){w['11']={class_type:'ImageScaleBy',inputs:{image:['6',0],upscale_method:'lanczos',scale_by:2}};w['7'].inputs.images=['11',0];w['7'].inputs.filename_prefix='ComfyStudio_Upscaled'}
  return w;
}

function diffusionWorkflow(v){
  const w={'1':{class_type:'UNETLoader',inputs:{unet_name:v.modelName,weight_dtype:'default'}},'2':{class_type:'CLIPLoader',inputs:{clip_name:v.clipModel,type:'qwen_image'}},'3':{class_type:'VAELoader',inputs:{vae_name:v.vaeModel}}};
  let model=['1',0],clip=['2',0],id=4;
  v.loras.forEach(l=>{w[id]={class_type:'LoraLoader',inputs:{lora_name:l.name,strength_model:l.weight,strength_clip:l.weight,model,clip}};model=[String(id),0];clip=[String(id),1];id++});
  const pos=String(id++),neg=String(id++),latent=String(id++),sample=String(id++),decode=String(id++),save=String(id++);
  w[pos]={class_type:'TextEncodeQwenImageEdit',inputs:{clip,prompt:v.positive}};w[neg]={class_type:'TextEncodeQwenImageEdit',inputs:{clip,prompt:v.negative}};
  w[latent]={class_type:'EmptySD3LatentImage',inputs:{width:v.width,height:v.height,batch_size:1}};
  w[sample]={class_type:'KSampler',inputs:{seed:v.seed<0?Math.floor(Math.random()*Number.MAX_SAFE_INTEGER):v.seed,steps:v.steps,cfg:v.cfg,sampler_name:v.sampler,scheduler:v.scheduler,denoise:1,model,positive:[pos,0],negative:[neg,0],latent_image:[latent,0]}};
  w[decode]={class_type:'VAEDecode',inputs:{samples:[sample,0],vae:['3',0]}};w[save]={class_type:'SaveImage',inputs:{filename_prefix:'ComfyStudio_Modular',images:[decode,0]}};return w
}

function modelChanged(setDefaults=true){
  const isDiffusion=els.model.value.startsWith('diffusion::');$('#diffusionSettings').classList.toggle('hidden',!isDiffusion);
  if(isDiffusion&&setDefaults){
    const pick=(select,needle)=>{const option=[...select.options].find(o=>o.value.toLowerCase().includes(needle));if(option)select.value=option.value};
    pick(els.clipModel,els.model.value.toLowerCase().includes('anima')?'anima':'qwen');pick(els.vaeModel,'qwenimage');els.width.value=832;els.height.value=1216;els.steps.value=25;els.cfg.value=7;
    if([...els.sampler.options].some(o=>o.value==='er_sde'))els.sampler.value='er_sde';if([...els.scheduler.options].some(o=>o.value==='normal'))els.scheduler.value='normal';toast('Anima-compatible workflow selected');
  }
}

function applySelectedAssets(model,loras){
  if(model){const type=state.diffusionModels.includes(model)?'diffusion':'checkpoint';els.model.value=`${type}::${model}`;modelChanged(true)}
  if(Array.isArray(loras)&&loras.length){els.loras.innerHTML='<div class="empty-note">No LoRAs added</div>';loras.forEach(addLora)}
}

async function generate(){
  const v=values();if(v.workflow!=='custom'&&!v.positive.trim())return toast('Add a positive prompt first');if(v.workflow!=='custom'&&!v.modelName)return toast('Use Write with AI to auto-select a model, or choose one manually');
  if(['img2img','inpaint'].includes(v.workflow)&&!v.referenceName)return toast('Choose and upload a reference image first');if(['img2img','inpaint'].includes(v.workflow)&&v.modelType==='diffusion')return toast('This reference workflow currently requires a checkpoint model');if(v.workflow==='custom'&&!state.customWorkflow)return toast('Import a ComfyUI API workflow first');
  els.generate.disabled=true;els.progress.classList.remove('hidden');els.status.textContent='Queued…';
  try{const ids=[];for(let i=0;i<v.batchCount;i++){const item={...v,seed:v.seed<0?-1:v.seed+i};const result=await api('/prompt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:workflow(item),client_id:'comfy-studio',front:item.priority})});ids.push(result.prompt_id);state.pending[result.prompt_id]=item}state.active=ids.at(-1);els.status.textContent=v.batchCount>1?`Generating batch of ${v.batchCount}…`:'Generating…';pollBatch(ids)}
  catch(e){finishLoading();toast(e.message)}
}
function pollBatch(ids){let remaining=new Set(ids),latest;clearInterval(state.poll);state.poll=setInterval(async()=>{for(const id of [...remaining])try{const h=await api('/history/'+id);if(h[id]){remaining.delete(id);const outs=extractOutputs({[id]:h[id]});if(outs.length){latest=outs[0];showOutput(latest);window.ComfyEnhancements?.recordGeneration(id,state.pending[id],outs,h[id])}delete state.pending[id]}}catch{}els.status.textContent=remaining.size?`${ids.length-remaining.size}/${ids.length} complete`:'Ready to create';if(!remaining.size){clearInterval(state.poll);finishLoading();await loadHistory();if(!latest)toast('Batch completed without media')}},1300)}
async function pollResult(id){
  clearInterval(state.poll);state.poll=setInterval(async()=>{try{const h=await api('/history/'+id);if(h[id]){clearInterval(state.poll);finishLoading();const outs=extractOutputs({[id]:h[id]});if(outs.length){showOutput(outs[0]);await loadHistory()}else toast(h[id].status?.status_str==='error'?'Generation failed in ComfyUI':'Generation completed with no media output')}}catch(e){clearInterval(state.poll);finishLoading();toast(e.message)}},1300)
}
function finishLoading(){els.generate.disabled=false;els.progress.classList.add('hidden');els.status.textContent='Ready to create'}
function mediaUrl(o){return `/api/view?filename=${encodeURIComponent(o.filename)}&subfolder=${encodeURIComponent(o.subfolder||'')}&type=${encodeURIComponent(o.type||'output')}`}
function extractOutputs(history){
  const out=[];Object.entries(history).forEach(([promptId,job])=>Object.values(job.outputs||{}).forEach(node=>{
    ['images','gifs','videos','audio'].forEach(kind=>(node[kind]||[]).forEach(file=>out.push({...file,kind,promptId,time:Number(promptId)||0})))
  }));return out.reverse()
}
function showOutput(o){
  const url=mediaUrl(o),isVideo=o.kind==='videos'||o.kind==='gifs'||/\.(mp4|webm|mov)$/i.test(o.filename);
  $('.placeholder').classList.add('hidden');els.preview.classList.toggle('hidden',isVideo);els.video.classList.toggle('hidden',!isVideo);
  if(isVideo)els.video.src=url;else els.preview.src=url;els.stage.classList.remove('empty');state.active=o;$('#openOriginal').classList.remove('hidden');$('#openOriginal').onclick=()=>window.open(url,'_blank');els.status.textContent=o.filename;
  document.querySelector('[data-view="create"]').click();
}
async function loadHistory(){
  try{state.outputs=extractOutputs(await api('/history?max_items=100'));renderHistory()}catch(e){toast('Could not load history')}
}
function mediaEl(o){const v=mediaUrl(o),isVideo=o.kind==='videos'||o.kind==='gifs'||/\.(mp4|webm|mov)$/i.test(o.filename);const el=document.createElement(isVideo?'video':'img');el.src=v;if(isVideo){el.muted=true;el.loop=true;el.onmouseenter=()=>el.play();el.onmouseleave=()=>el.pause()}el.loading='lazy';return el}
function renderHistory(){
  els.recent.innerHTML='';els.gallery.innerHTML='';if(!state.outputs.length){els.recent.innerHTML='<div class="empty-note">Your latest work will appear here</div>';els.gallery.innerHTML='<div class="empty-note">No ComfyUI output history yet.</div>';return}
  state.outputs.slice(0,8).forEach(o=>{const m=mediaEl(o);m.className='thumb';m.onclick=()=>showOutput(o);els.recent.append(m)});
  state.outputs.forEach(o=>{const card=document.createElement('article');card.className='card';const m=mediaEl(o);const info=document.createElement('div');info.className='card-info';info.innerHTML=`<span>${escapeHtml(o.filename)}</span><span>${o.kind.slice(0,-1)}</span>`;card.append(m,info);card.onclick=()=>showOutput(o);els.gallery.append(card)})
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function presets(){return JSON.parse(localStorage.getItem('comfy-studio-presets')||'{}')}
function renderPresets(){const p=presets();els.presets.innerHTML='<option value="">Load a saved preset…</option>';Object.keys(p).sort().forEach(n=>els.presets.add(new Option(n,n)))}

async function loadSettings(){
  try{const r=await fetch('/api/config'),c=await r.json();$('#settingComfyUrl').value=c.comfyUrl||'';$('#settingComfyRoot').value=c.comfyRoot||'';$('#settingLlmUrl').value=c.llmUrl||'';$('#settingLlmModel').value=c.llmModel||'';$('#settingLlmKey').placeholder=c.hasLlmApiKey?'Key saved — leave blank to keep it':'Optional';renderFolderStatus(c.rootStatus)}catch{toast('Could not load settings')}
}
function renderFolderStatus(s={}){const el=$('#folderStatus');if(s.configured&&!s.accessible){el.textContent='Folder unavailable here — API fallback active';el.className='source-status warning'}else if(s.accessible){const d=s.detected||{};el.textContent=`Folder available — ${d.checkpoints||0} checkpoints, ${d.diffusionModels||0} diffusion models, ${d.loras||0} LoRAs`;el.className='source-status'}else{el.textContent='ComfyUI API discovery active';el.className='source-status'}}
async function saveSettings(){
  const button=$('#saveSettings');button.disabled=true;
  try{const r=await fetch('/api/config',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({comfyUrl:$('#settingComfyUrl').value,comfyRoot:$('#settingComfyRoot').value,llmUrl:$('#settingLlmUrl').value,llmModel:$('#settingLlmModel').value,llmApiKey:$('#settingLlmKey').value})});const c=await r.json();if(!r.ok)throw new Error(c.error);$('#settingLlmKey').value='';renderFolderStatus(c.rootStatus);toast('Settings saved');await connect()}
  catch(e){toast(e.message)}finally{button.disabled=false}
}
async function testLlm(){
  const button=$('#testLlm'),status=$('#llmTestStatus');button.disabled=true;button.textContent='Testing…';status.textContent='Contacting provider…';status.className='source-status';
  try{const r=await fetch('/api/llm/test',{method:'POST'}),d=await r.json();if(!r.ok)throw new Error(d.error||'Connection failed');status.textContent=`Connected — ${d.model}`;status.className='source-status success';toast('AI prompt writer connection works')}
  catch(e){status.textContent=e.message;status.className='source-status error';toast('AI connection test failed')}
  finally{button.disabled=false;button.textContent='Test connection'}
}

$('#addLora').onclick=()=>addLora();$('#generate').onclick=generate;$('#randomSeed').onclick=()=>els.seed.value=Math.floor(Math.random()*Number.MAX_SAFE_INTEGER);els.model.onchange=()=>modelChanged(true);
$('#savePreset').onclick=()=>{const name=prompt('Name this preset:');if(!name)return;const p=presets();p[name]=values();localStorage.setItem('comfy-studio-presets',JSON.stringify(p));renderPresets();els.presets.value=name;toast(`Saved “${name}”`)};
els.presets.onchange=()=>{const p=presets();if(p[els.presets.value]){apply(p[els.presets.value]);toast('Preset loaded')}};
document.querySelectorAll('.nav').forEach(b=>b.onclick=()=>{document.querySelectorAll('.nav').forEach(x=>x.classList.toggle('active',x===b));$('#createView').classList.toggle('hidden',b.dataset.view!=='create');$('#historyView').classList.toggle('hidden',b.dataset.view!=='history');$('#settingsView').classList.toggle('hidden',b.dataset.view!=='settings');if(b.dataset.view==='settings')loadSettings()});
$('#seeAll').onclick=()=>document.querySelector('[data-view="history"]').click();$('#refreshHistory').onclick=loadHistory;
$('#saveSettings').onclick=saveSettings;$('#testLlm').onclick=testLlm;$('#refreshModels').onclick=async()=>{await connect();toast('Model index refreshed')};
$('#openPromptWriter').onclick=()=>{$('#promptWriter').classList.remove('hidden');$('#promptIdea').focus()};$('#cancelPromptWriter').onclick=()=>$('#promptWriter').classList.add('hidden');$('#writePrompt').onclick=async()=>{const b=$('#writePrompt');b.disabled=true;b.textContent='Checking LoRA triggers…';try{await resolveLoraTriggers();b.textContent='Choosing assets…';const current=values();const r=await fetch('/api/prompt-writer',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({idea:$('#promptIdea').value,model:current.modelName,loras:current.loras,bodyType:$('#writerBody').value,characterAccuracy:$('#writerAccuracy').value})});const d=await r.json();if(!r.ok)throw new Error(d.error);applySelectedAssets(d.model,d.loras);state.assetSelection=d.selection;els.positive.value=d.prompt;els.negative.value=d.negative;$('#promptWriter').classList.add('hidden');toast(`Prompt ready — ${d.model||'assets selected'}`)}catch(e){toast(e.message)}finally{b.disabled=false;b.textContent='Create prompt'}};
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter')generate()});
renderPresets();connect();
