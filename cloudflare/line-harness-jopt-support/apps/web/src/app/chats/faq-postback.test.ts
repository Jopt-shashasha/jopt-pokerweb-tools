import { describe,expect,it } from 'vitest';
import { faqPostbackLabel } from './faq-postback';
describe('FAQ postback presentation',()=>{
  const value='faqv1:release:session:node:games_membership';
  const outgoing={direction:'outgoing',messageType:'flex',content:JSON.stringify({body:{contents:[{action:{type:'postback',data:value,label:'メンバーシップ'}}]}})};
  it('uses the label from the original LINE card for historical clicks',()=>expect(faqPostbackLabel({direction:'incoming',messageType:'text',source:'postback',content:value},[outgoing])).toBe('FAQ：メンバーシップ'));
  it('never changes ordinary user text that resembles a postback',()=>expect(faqPostbackLabel({direction:'incoming',messageType:'text',source:'user',content:value},[outgoing])).toBeNull());
  it('provides safe labels when the original card is unavailable',()=>{
    expect(faqPostbackLabel({direction:'incoming',messageType:'text',source:'postback',content:'faqv1:test'},[])).toBe('FAQを開いた');
    expect(faqPostbackLabel({direction:'incoming',messageType:'text',source:'postback',content:'faqv1:r:s:resolved:q'},[])).toBe('FAQ：解決した');
  });
});
