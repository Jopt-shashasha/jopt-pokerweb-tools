type Item = { direction:string; messageType:string; content:string; source?:string|null };
function findAction(value:unknown, data:string):string|undefined {
  if(!value||typeof value!=='object') return undefined;
  if(Array.isArray(value)){for(const item of value){const found=findAction(item,data);if(found)return found;}return undefined;}
  const obj=value as Record<string,unknown>;
  if(obj.type==='postback'&&obj.data===data&&typeof obj.label==='string')return obj.label;
  for(const child of Object.values(obj)){const found=findAction(child,data);if(found)return found;}
  return undefined;
}
export function faqPostbackLabel(message:Item, earlier:Item[]):string|null {
  if(message.direction!=='incoming'||message.source!=='postback'||!message.content.startsWith('faqv1:'))return null;
  for(let i=earlier.length-1;i>=0;i--){const m=earlier[i];if(m.direction!=='outgoing'||m.messageType!=='flex')continue;
    try{const label=findAction(JSON.parse(m.content),message.content);if(label)return `FAQ：${label}`;}catch{/* Older or malformed messages have a generic fallback. */}
  }
  if(/^faqv1:(start|test)(:human)?$/.test(message.content))return 'FAQを開いた';
  const action=message.content.split(':')[3];
  return action==='resolved'?'FAQ：解決した':action==='handoff'?'FAQ：担当者に相談':'FAQの選択';
}
