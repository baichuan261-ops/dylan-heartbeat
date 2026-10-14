function parsePushText(raw, fallbackTitle = 'Silas') {
  let text = String(raw || '').trim();
  const wrapped = text.match(/\[BARK\]([\s\S]*?)\[\/BARK\]/i);
  text = (wrapped ? wrapped[1] : text).replace(/^\[BARK\]|\[\/BARK\]$/gi, '').trim();
  text = text.replace(/\\r\\n|\\n/g, '\n');
  try {
    const obj = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    if (typeof obj.title === 'string' && typeof (obj.body ?? obj.message) === 'string') {
      return { title: obj.title.trim() || fallbackTitle, body: (obj.body ?? obj.message).trim() };
    }
  } catch {}
  const labeled = text.match(/^\s*(?:\*\*)?标题(?:\*\*)?[：:]\s*([\s\S]*?)\s*(?:\*\*)?正文(?:\*\*)?[：:]\s*([\s\S]*)$/);
  if (labeled) return { title: labeled[1].trim() || fallbackTitle, body: labeled[2].trim() };
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) return { title: '', body: '' };
  if (lines.length === 1) return { title: fallbackTitle, body: lines[0] };
  return { title: lines[0].replace(/^标题[：:]\s*/, ''), body: lines.slice(1).join('\n').replace(/^正文[：:]\s*/, '') };
}
module.exports = { parsePushText };
