import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.js';
import { News,parseNewsFeed,isProductNews } from '../src/news.js';
const digest=`<rss><channel><title>Test News</title><item><title>朝のAIニュースまとめ</title><link>https://example.com/daily</link><pubDate>Tue, 17 Nov 2026 00:00:00 GMT</pubDate><content:encoded><![CDATA[<h3>今日の概要</h3><p>まとめの導入です。</p><h3>目次</h3><ol><li>記事一</li></ol><h3 id="first">&#x65b0;&#x6a5f;&#x80fd; &amp; 改善</h3><ul><li>新しい機能を公開しました。</li><li>仕事で利用できます。<script>bad()</script></li></ul><blockquote><a href="javascript:alert(1)">bad</a><a href="https://example.org/source">出典</a></blockquote><h3 id="second">別の記事</h3><ul><li>二番目のニュース内容です。</li></ul>]]></content:encoded></item></channel></rss>`;
test('daily digest becomes individual headlines with content excerpts, safe citations and decoded Japanese',()=>{
 const items=parseNewsFeed(digest,'https://example.com/rss');assert.equal(items.length,2);
 assert.equal(items[0].title,'新機能 & 改善');assert.equal(items[0].url,'https://example.com/daily#first');assert.equal(items[0].source_url,'https://example.org/source');
 assert.equal(items[0].summary,'新しい機能を公開しました。\n仕事で利用できます。');assert.equal(items[0].published_at,'2026-11-17T00:00:00.000Z');
 assert.ok(!JSON.stringify(items).includes('bad()'));assert.ok(!items.some(n=>n.title.includes('まとめ')||n.title==='目次'));
});
test('regular RSS and Atom stories retain descriptions; unsafe links and an unrecognized digest do not become headlines',()=>{
 const rss='<rss><channel><title>Source</title><item><title>Ordinary article</title><link>https://example.com/story</link><description><![CDATA[<p>Article content.</p>]]></description></item><item><title>Unsafe</title><link>javascript:alert(1)</link></item><item><title>AIニュースまとめ</title><link>https://example.com/daily</link></item></channel></rss>';
 const items=parseNewsFeed(rss,'https://example.com/rss');assert.equal(items.length,1);assert.equal(items[0].summary,'Article content.');assert.equal(items[0].format,'article');
 const atom='<feed><title>Atom source</title><entry><title>Atom article</title><link rel="self" href="https://example.com/api"/><link rel="alternate" href="https://example.com/article"/><summary>Useful content</summary><updated>2026-11-17T01:00:00Z</updated></entry></feed>';
 assert.equal(parseNewsFeed(atom,'https://example.com/atom')[0].url,'https://example.com/article');
});
test('news uses a shared one-hour cache, coalesces fetches, replaces daily-only cache and retains usable excerpts during outages',async()=>{
 const db=new Store(':memory:');let t=10000,calls=0,fail=false;
 const relevant=digest.replace('&#x65b0;&#x6a5f;&#x80fd; &amp; 改善','ChatGPT 新機能 &amp; 改善').replace('別の記事','Claudeの新モデル公開');
 const fetcher:typeof fetch=async()=>{calls++;if(fail)throw Error('offline');return new Response(relevant,{headers:{'content-type':'application/rss+xml'}});};
 try{
  db.run('INSERT INTO news_cache VALUES (1,?,?)',JSON.stringify([{title:'古いまとめ',url:'https://example.com/old',source:'old',published_at:null}]),t);
  const news=new News(db,['https://example.com/rss'],fetcher,()=>t);
  const [a,b]=await Promise.all([news.get(),news.get()]);assert.equal(calls,1);assert.equal(a.items.length,2);assert.deepEqual(a,b);
  await news.get();assert.equal(calls,1);t+=3601;fail=true;
  const cached=await news.get();assert.equal(cached.stale,true);assert.ok(cached.error);assert.equal(cached.items[0].summary,a.items[0].summary);
 }finally{db.close();}
});

test('editorial scope keeps usable AI product updates and rejects industry, financial and policy news',()=>{
 for(const title of ['Claudeの新モデルを公開','新しいAIツールが登場','ChatGPTの議事録機能がGoogle Calendarに対応','Grok Botが正式版へアップデート','Hugging FaceがOpenRouterと統合','Codexの活用手順を紹介','AIサービスの利用枠を拡大・値下げ','Fable 5.2の登場を記念した無料枠リセット','Claudeの使用上限を期間限定で増加','ChatGPTの新プランを無料試用','Codex usage limit reset available today'])assert.equal(isProductNews({title}),true,title);
 for(const title of ['米商務省、海外DC経由のAIチップ利用規制で暫定規則','SemiAnalysis、AI設備投資予測を28%下方修正','OpenAI、内部モデルを開放し安全性評価','AIエージェント新会社が資金調達を発表','サイバー防御特化の基盤モデルを開発するCormaが$125M調達','MicrosoftらがOpus 5.5で重み直接記述を検証','OpenAIを提訴、新機能に訴訟','企業のOSSモデル利用比率が30%に','Fable 5.2、発売1週目でAnthropic支出の11%','AI市場の売上予測を公開'])assert.equal(isProductNews({title,summary:'新しいAIモデルをリリースしました。'}),false,title);
});

test('off-topic cache entries stay filtered during outages and no-match feeds cache an empty list without padding',async()=>{
 const db=new Store(':memory:');let calls=0;const t=20000;
 const fetcher:typeof fetch=async()=>{calls++;throw Error('offline');};
 try{
  const record={url:'https://example.com/story',source:'test',published_at:null,summary:'AIの新しい発表',format:'story'};
  db.run('INSERT INTO news_cache VALUES (1,?,?)',JSON.stringify([{...record,title:'AIの投資予測を発表'},{...record,title:'Claudeの新モデルを公開'}]),t-4000);
  const cached=await new News(db,['https://example.com/rss'],fetcher,()=>t).get();assert.equal(cached.stale,true);assert.deepEqual(cached.items.map(n=>n.title),['Claudeの新モデルを公開']);
  db.run('DELETE FROM news_cache');calls=0;
  const onlyIndustry:typeof fetch=async()=>{calls++;return new Response('<rss><channel><title>AI</title><item><title>AI企業が資金調達を発表</title><link>https://example.com/funding</link><description>新ツールの開発資金</description></item></channel></rss>');};
  const news=new News(db,['https://example.com/rss'],onlyIndustry,()=>t);assert.deepEqual((await news.get()).items,[]);assert.deepEqual((await news.get()).items,[]);assert.equal(calls,1);
 }finally{db.close();}
});
