import MarkdownIt from 'markdown-it';
const renderer=new MarkdownIt({html:false,linkify:false});
renderer.renderer.rules.image=(tokens,index)=>renderer.utils.escapeHtml(tokens[index].content);
const linkOpen=renderer.renderer.rules.link_open;
renderer.renderer.rules.link_open=(tokens,index,options,env,self)=>{tokens[index].attrSet('rel','noopener noreferrer');tokens[index].attrSet('target','_blank');return linkOpen?linkOpen(tokens,index,options,env,self):self.renderToken(tokens,index,options);};
export const renderMarkdown=(text:string)=>renderer.render(text);
