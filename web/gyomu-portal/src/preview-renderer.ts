import {chromium} from 'playwright-core';
import {existsSync} from 'node:fs';
import {load} from 'cheerio';

export interface PreviewRenderer {render(html:string):Promise<Uint8Array<ArrayBuffer>>}
export class LocalPreviewRenderer implements PreviewRenderer {
 constructor(private executablePath=process.env.PORTAL_CHROMIUM_PATH||
  (process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/chromium')){}
 available(){return existsSync(this.executablePath);}
 async render(html:string){
  if(!this.available())throw Error('Preview renderer is not configured');
  // Render only supplied file content in a fresh, offline browser. Never attach to a user's browser.
  const browser=await chromium.launch({executablePath:this.executablePath,headless:true,chromiumSandbox:true,timeout:10000});
  try{
   const context=await browser.newContext({viewport:{width:1200,height:675},deviceScaleFactor:1,javaScriptEnabled:false,offline:true,serviceWorkers:'block',acceptDownloads:false,colorScheme:'light'});
   await context.route('**/*',route=>route.abort());
   const $=load(html);$('script,iframe,frame,object,embed,link,base,meta[http-equiv],audio,video,source').remove();
   $('head').prepend('<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;; img-src data:; font-src data:; base-uri &#39;none&#39;; form-action &#39;none&#39;">');
   const page=await context.newPage();await page.setContent($.html(),{waitUntil:'load',timeout:6000});
   const image=await page.screenshot({type:'jpeg',quality:78,timeout:6000,animations:'disabled'});await context.close();return new Uint8Array(image);
  }finally{await browser.close();}
 }
}
