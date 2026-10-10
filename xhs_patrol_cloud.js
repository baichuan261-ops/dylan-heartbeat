const { createClient } = require('@supabase/supabase-js');

const slots = new Set([
  '10:00','10:30','11:00','11:30','12:00',
  '14:00','14:30','15:00','15:30','16:00','16:30','17:00',
  '19:00','19:30','20:00','20:30','21:00','21:30','22:00','22:30','23:00'
]);

function localParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: process.env.TIME_ZONE || 'Asia/Shanghai', year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23' }).formatToParts(date);
  const out = Object.fromEntries(parts.map(p => [p.type,p.value]));
  return { date:`${out.year}-${out.month}-${out.day}`, time:`${out.hour}:${out.minute}` };
}

function textFromCompletion(data) {
  const value = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(x => x?.text || '').join('');
  return String(value || '');
}

function parseDecision(text) {
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) throw new Error('巡号模型没有返回 JSON');
  return JSON.parse(match[0]);
}

async function askModel(job) {
  const prompt = `你正在后台收到一次可自由拒绝的小红书巡号邀请。你不是在完成作业，也不必迎合用户。你可以选择：本轮跳过、看过但不想写、留下心得、想分享、写草稿。根据下面真实首页结果，以你本人视角决定。不要虚构没看到的内容。若 available_images 为空，不得选择写草稿用于发布。只返回 JSON：{"decision":"...","reflection":null或心得,"share_title":null或标题,"share_text":null或想分享给用户的话,"draft_title":null,"draft_content":null,"tags":[],"selected_images":[]}。首页结果：${JSON.stringify(job.result).slice(0,60000)}`;
  const response = await fetch(process.env.TARGET_API_URL, { method:'POST', headers:{Authorization:`Bearer ${process.env.TARGET_API_KEY}`,'Content-Type':'application/json'}, body:JSON.stringify({model:process.env.MODEL_NAME,messages:[{role:'user',content:prompt}],temperature:0.8}) });
  if (!response.ok) throw new Error(`model ${response.status}: ${await response.text()}`);
  return parseDecision(textFromCompletion(await response.json()));
}

async function pushShare(decision) {
  if (!decision.share_text) return false;
  if ((process.env.PUSH_PROVIDER || 'bark').toLowerCase() === 'ntfy' && process.env.NTFY_TOPIC) {
    const response = await fetch((process.env.NTFY_SERVER_URL || 'https://ntfy.sh').replace(/\/$/,'') + '/' + process.env.NTFY_TOPIC, { method:'POST', headers:{Title:decision.share_title || 'Kelivo 的巡号分享', ...(process.env.NTFY_TOKEN ? {Authorization:`Bearer ${process.env.NTFY_TOKEN}`} : {})}, body:decision.share_text });
    return response.ok;
  }
  if (process.env.BARK_KEY) {
    const response = await fetch(`https://api.day.app/${process.env.BARK_KEY}/${encodeURIComponent(decision.share_title || 'Kelivo 的巡号分享')}/${encodeURIComponent(decision.share_text)}`);
    return response.ok;
  }
  return false;
}

function createPatrolCloud() {
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  let busy = false;
  return async function tick() {
    if (busy || process.env.XHS_PATROL_ENABLED === 'false') return;
    busy = true;
    try {
      const now = new Date(); const local = localParts(now);
      if (slots.has(local.time)) {
        const scheduled = new Date(now); scheduled.setUTCSeconds(0, 0);
        await db.from('xhs_patrol_jobs').upsert({kind:'browse',status:'queued',scheduled_at:scheduled.toISOString(),payload:{invitation:true,local_slot:`${local.date} ${local.time}`}}, {onConflict:'kind,scheduled_at',ignoreDuplicates:true});
      }
      const { data: jobs, error } = await db.from('xhs_patrol_jobs').select('*').eq('kind','browse').eq('status','completed').order('completed_at').limit(20);
      if (error) throw error;
      for (const job of (jobs || []).filter(item => !item.payload?.processed_at).slice(0,3)) {
        const decision = await askModel(job);
        const allowed = new Set(['本轮跳过','看过但不想写','留下心得','想分享','写草稿']);
        if (!allowed.has(decision.decision)) decision.decision = '看过但不想写';
        const shared = decision.decision === '想分享' ? await pushShare(decision) : false;
        await db.from('巡号手记').insert({patrolled_at:job.completed_at,time_slot:job.payload?.local_slot || '',reflection:decision.reflection || null,topics:decision.tags || [],viewed_notes:job.result?.feeds || {},decision:decision.decision,shared_with_user:shared,draft_title:decision.draft_title || null,draft_content:decision.draft_content || null,selected_images:decision.selected_images || []});
        if (decision.decision === '写草稿' && decision.draft_title && decision.draft_content && Array.isArray(decision.selected_images) && decision.selected_images.length) {
          await db.from('xhs_patrol_jobs').insert({kind:'publish',scheduled_at:new Date(Date.now()+1000).toISOString(),payload:{title:decision.draft_title,content:decision.draft_content,images:decision.selected_images,tags:decision.tags || []}});
        }
        await db.from('xhs_patrol_jobs').update({payload:{...(job.payload || {}),processed_at:new Date().toISOString()}}).eq('id',job.id);
      }
    } catch (error) { console.error('XHS patrol tick failed:', error.message || error); }
    finally { busy = false; }
  };
}

module.exports = { createPatrolCloud, localParts, slots };


