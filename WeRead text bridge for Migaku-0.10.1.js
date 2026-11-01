// ==UserScript==
// @name         WeRead text bridge for Migaku
// @author       Baroni Fabio
// @license      MIT
// @namespace    local.weread.migaku
// @version      0.10.1
// @description  Capture rendered canvas text into a normal HTML reading panel.
// @match        https://weread.qq.com/web/reader/*
// @match        https://weread.qq.com/web/shelf*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @noframes
// @downloadURL https://update.greasyfork.org/scripts/603208/WeRead%20text%20bridge%20for%20Migaku.user.js
// @updateURL https://update.greasyfork.org/scripts/603208/WeRead%20text%20bridge%20for%20Migaku.meta.js
// ==/UserScript==

/*
MIT License

Copyright (c) 2026 Baroni Fabio

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

(() => {
  'use strict';
  if (window.__wereadMigakuBridge) return;
  window.__wereadMigakuBridge = true;
  const coveragePrefix='wrmb:coverage:v1:';
  function bookId(url) {
    const match=String(url).match(/\/web\/reader\/([^/?#]+)/);
    return match?match[1].split('k')[0]:null;
  }
  function fingerprint(text) {
    let a=2166136261,b=5381;
    for(let i=0;i<text.length;i++){a=Math.imul(a^text.charCodeAt(i),16777619);b=Math.imul(b,33)^text.charCodeAt(i);}
    return (a>>>0).toString(36)+'-'+(b>>>0).toString(36)+'-'+text.length;
  }
  function loadCoverage(id) {
    try{const data=JSON.parse(localStorage.getItem(coveragePrefix+id)||'null');
      if(data?.version===1 && data.samples && data.words)return data;
    }catch(_){}
    return {version:1,samples:{},words:{},updated:0,scan:null};
  }
  function totals(data,ids=Object.keys(data.samples)) {
    const counts={KNOWN:0,LEARNING:0,UNKNOWN:0,IGNORED:0};
    for(const id of ids)for(const [key,n] of Object.entries(data.samples[id]?.histogram||{})) {
      const status=data.words[key];if(Object.hasOwn(counts,status))counts[status]+=n;
    }
    const total=counts.KNOWN+counts.LEARNING+counts.UNKNOWN;
    return {...counts,total,percent:total?counts.KNOWN/total*100:null,spreads:ids.length};
  }
  function percentage(value){return value===null?'—':value.toFixed(1)+'%';}
  function xml(value) {
    return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  }
  function zipStored(files) {
    const encoder=new TextEncoder(),parts=[],central=[];
    const table=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
    let offset=0;
    if(files.length>65535)throw new Error('Too many EPUB files.');
    for(const file of files) {
      const name=encoder.encode(file.name),data=encoder.encode(file.text);
      if(data.length>0xffffffff || offset+data.length>0xffffffff)throw new Error('EPUB exceeds the supported ZIP size.');
      let crc=0xffffffff;for(const byte of data)crc=table[(crc^byte)&255]^(crc>>>8);crc=(crc^0xffffffff)>>>0;
      const local=new Uint8Array(30+name.length),v=new DataView(local.buffer);
      v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x800,true);v.setUint16(12,33,true);
      v.setUint32(14,crc,true);v.setUint32(18,data.length,true);v.setUint32(22,data.length,true);v.setUint16(26,name.length,true);local.set(name,30);
      parts.push(local,data);
      const entry=new Uint8Array(46+name.length),e=new DataView(entry.buffer);
      e.setUint32(0,0x02014b50,true);e.setUint16(4,20,true);e.setUint16(6,20,true);e.setUint16(8,0x800,true);e.setUint16(14,33,true);
      e.setUint32(16,crc,true);e.setUint32(20,data.length,true);e.setUint32(24,data.length,true);e.setUint16(28,name.length,true);e.setUint32(42,offset,true);entry.set(name,46);central.push(entry);
      offset+=local.length+data.length;
    }
    const centralSize=central.reduce((n,p)=>n+p.length,0),end=new Uint8Array(22),ev=new DataView(end.buffer);
    ev.setUint32(0,0x06054b50,true);ev.setUint16(8,files.length,true);ev.setUint16(10,files.length,true);ev.setUint32(12,centralSize,true);ev.setUint32(16,offset,true);
    const output=new Uint8Array(offset+centralSize+end.length);let at=0;
    for(const part of [...parts,...central,end]){output.set(part,at);at+=part.length;}
    return output;
  }
  function epubChapters(archive) {
    const chapters=[];let current=null;
    for(const spread of archive.spreads) {
      const headings=new Set(spread.headings);
      const containsHeading=spread.paragraphs.some(p=>headings.has(p));
      // Prefer in-text chapter headings: a spread can straddle two chapters.
      if(!current || (!containsHeading && spread.chapter && spread.chapter!==current.title)) {
        current={title:spread.chapter||'Captured text',paragraphs:[]};chapters.push(current);
      }
      for(let i=0;i<spread.paragraphs.length;i++) {
        const text=spread.paragraphs[i];
        if(headings.has(text)) {
          if(current.title!==text || current.paragraphs.length){current={title:text,paragraphs:[]};chapters.push(current);}
          continue;
        }
        const last=current.paragraphs.at(-1);
        if(i===0 && last && !/[。！？!?…][”’」』）)]?$/.test(last)) {
          current.paragraphs[current.paragraphs.length-1]+=text;
        } else current.paragraphs.push(text);
      }
    }
    return chapters.filter(c=>c.paragraphs.length);
  }
  function makeEpub(archive) {
    const chapters=epubChapters(archive);if(!chapters.length)throw new Error('No captured chapter text is available.');
    const title=archive.title+(archive.complete?' — Captured text':' — Partial capture');
    const note=archive.complete?'The scan reached WeRead’s end screen. This EPUB contains captured accessible text.':'PARTIAL CAPTURE — this is not the whole book.';
    const css='body{font-family:serif;line-height:1.8;margin:5%}p{text-indent:2em;margin:.6em 0}h1{line-height:1.4}a{overflow-wrap:anywhere}';
    const page=(heading,body)=>'<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN" lang="zh-CN"><head><title>'+xml(heading)+'</title><meta charset="utf-8"/><style>'+css+'</style></head><body>'+body+'</body></html>';
    const chapterFiles=chapters.map((c,i)=>({name:'OEBPS/chapter-'+(i+1)+'.xhtml',text:page(c.title,'<h1>'+xml(c.title)+'</h1>'+c.paragraphs.map(p=>'<p>'+xml(p)+'</p>').join(''))}));
    const modified=new Date().toISOString().replace(/\.\d{3}Z$/,'Z');
    const id='urn:weread-capture:'+archive.bookId+':'+archive.started;
    const files=[{name:'mimetype',text:'application/epub+zip'},
      {name:'META-INF/container.xml',text:'<?xml version="1.0" encoding="utf-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'},
      {name:'OEBPS/info.xhtml',text:page(title,'<h1>'+xml(title)+'</h1><p>'+xml(note)+'</p><p>'+xml(archive.reason||'Scan in progress or stopped before completion.')+'</p><p>'+archive.spreads.length+' captured spreads. Paragraphs and chapter boundaries are reconstructed. Images, publisher formatting, and front cover artwork are not included.</p><p>Source: <a href="'+xml(archive.source)+'">WeRead</a></p>')},
      {name:'OEBPS/nav.xhtml',text:'<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN"><head><title>Contents</title></head><body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol><li><a href="info.xhtml">Capture information</a></li>'+chapters.map((c,i)=>'<li><a href="chapter-'+(i+1)+'.xhtml">'+xml(c.title)+'</a></li>').join('')+'</ol></nav></body></html>'},
      {name:'OEBPS/content.opf',text:'<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">'+xml(id)+'</dc:identifier><dc:title>'+xml(title)+'</dc:title><dc:language>zh-CN</dc:language><dc:creator>'+xml(archive.author||'Unknown author')+'</dc:creator><dc:source>'+xml(archive.source)+'</dc:source><dc:description>'+xml(note)+'</dc:description><meta property="dcterms:modified">'+modified+'</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="info" href="info.xhtml" media-type="application/xhtml+xml"/>'+chapters.map((c,i)=>'<item id="chapter'+(i+1)+'" href="chapter-'+(i+1)+'.xhtml" media-type="application/xhtml+xml"/>').join('')+'</manifest><spine><itemref idref="info"/>'+chapters.map((c,i)=>'<itemref idref="chapter'+(i+1)+'"/>').join('')+'</spine></package>'},...chapterFiles];
    return zipStored(files);
  }
  function shelfBadges() {
    const style=document.createElement('style');style.textContent='.wrmb-coverage-badge{position:absolute;left:4px;bottom:4px;z-index:5;padding:4px 6px;border-radius:6px;background:#181821ed;color:#fff;font:11px/1.3 system-ui;pointer-events:none;max-width:95%;box-sizing:border-box}';document.head.append(style);
    const update=()=>{
      for(const link of document.querySelectorAll('a[href*="/web/reader/"]')) {
        const id=bookId(link.href);if(!id)continue;
        const data=loadCoverage(id),stats=totals(data);
        let badge=link.querySelector('.wrmb-coverage-badge');
        if(!stats.total){badge?.remove();continue;}
        if(!badge){badge=document.createElement('span');badge.className='wrmb-coverage-badge';link.style.position='relative';link.append(badge);}
        const complete=data.scan?.complete;
        const shown=complete?totals(data,data.scan.ids):stats;
        const label=percentage(shown.percent)+' known · '+(complete?'scanned text':data.scan?.result==='access-limit'?'preview sample':'sample');
        if(badge.textContent!==label)badge.textContent=label;
        badge.title=shown.spreads+' analysed spreads · '+new Date(data.updated).toLocaleString()+' · Saved Migaku vocabulary snapshot';
      }
    };
    let timer;new MutationObserver(()=>{clearTimeout(timer);timer=setTimeout(update,300);}).observe(document.body,{childList:true,subtree:true});
    window.addEventListener('storage',update);update();
  }
  if(location.pathname.startsWith('/web/shelf')) {
    if(document.body)shelfBadges();else document.addEventListener('DOMContentLoaded',shelfBadges,{once:true});
    return;
  }
  const buffers = new WeakMap();
  let changed=()=>{}, revision=0;

  function rowsOf(buffer) {
    if (buffer.rowsRevision===buffer.revision) return buffer.rows;
    const rows=[];
    for (const item of [...buffer.items].sort((a,b)=>a.y-b.y || a.x-b.x)) {
      let row=rows.at(-1);
      if (!row || Math.abs(row.y-item.y)>Math.max(2,item.size*.15)) {
        row={y:item.y,items:[]}; rows.push(row);
      }
      row.items.push(item);
    }
    buffer.rows=rows.map(row=>{
      const items=row.items.sort((a,b)=>a.x-b.x);
      return {text:items.map(p=>p.text).join('').trim(),x:items[0].x,y:row.y,
        right:Math.max(...items.map(p=>p.x+p.width)),size:Math.max(...items.map(p=>p.size))};
    }).filter(row=>row.text);
    buffer.rowsRevision=buffer.revision;
    return buffer.rows;
  }

  function paragraphsOf(pages) {
    const result=[];
    let previous=null;
    const median=values=>{const v=values.sort((a,b)=>a-b);return v[Math.floor(v.length/2)]||0;};
    for (const rows of pages) {
      if (!rows.length) continue;
      const left=Math.min(...rows.map(r=>r.x)), right=Math.max(...rows.map(r=>r.right));
      const typicalSize=median(rows.map(r=>r.size));
      const gaps=rows.slice(1).map((r,i)=>r.y-rows[i].y).filter(n=>n>0);
      const pitch=median(gaps)||typicalSize*1.8;
      for (let i=0;i<rows.length;i++) {
        const row=rows[i], prior=rows[i-1];
        const heading=row.size>typicalSize*1.2 || (i===0 && row.text.length<=6 && rows[1] &&
          rows[1].y-row.y>pitch*1.4 && !/[。！？!?]/.test(row.text));
        const indented=row.x-left>row.size*.9;
        const gap=prior && row.y-prior.y>pitch*1.4;
        const priorShort=prior && prior.right<right-prior.size*2;
        const previousEnds=previous && /[。！？!?…][”’」』）)]?$/.test(previous.text);
        const metadata=/:|：/.test(row.text) && row.text.length<55;
        const startsNew=!previous || heading || previous.heading || indented || gap || metadata ||
          (priorShort && previousEnds) || (!prior && previousEnds);
        if (startsNew) {
          previous={text:row.text,heading};result.push(previous);
        } else {
          // CJK wraps are joined without inserting spaces; Latin words retain one.
          const space=/[A-Za-z0-9]$/.test(previous.text) && /^[A-Za-z0-9]/.test(row.text)?' ':'';
          previous.text+=space+row.text;
        }
      }
    }
    return result.map(p=>p.text);
  }

  function bufferFor(canvas) {
    let b = buffers.get(canvas);
    if (!b || b.width!==canvas.width || b.height!==canvas.height) {
      b = {items:[], width:canvas.width, height:canvas.height,revision:++revision,updated:Date.now()};
      buffers.set(canvas,b);
    }
    return b;
  }

  const proto = window.CanvasRenderingContext2D?.prototype;
  if (proto) {
    for (const method of ['fillText','strokeText']) {
      const original = proto[method];
      proto[method] = function(...args) {
        const result = Reflect.apply(original,this,args);
        try {
          const [value,x,y] = args;
          const text = String(value);
          if (!text.trim() || !Number.isFinite(x) || !Number.isFinite(y)) return result;
          const b = bufferFor(this.canvas);
          const m = this.getTransform();
          const point = {text, x:m.a*x+m.c*y+m.e, y:m.b*x+m.d*y+m.f,
            width:(this.measureText?.(text).width || text.length*20)*Math.hypot(m.a,m.b),
            size:(parseFloat(this.font.match(/[\d.]+px/)?.[0])||20)*Math.hypot(m.c,m.d)};
          b.items = b.items.filter(p => Math.abs(p.x-point.x)>.5 || Math.abs(p.y-point.y)>.5);
          b.items.push(point);
          if (b.items.length > 24000) b.items.splice(0,12000);
          b.revision=++revision; b.updated=Date.now(); changed();
        } catch (error) { console.debug('WeRead text bridge capture:',error); }
        return result;
      };
    }
    const originalClear = proto.clearRect;
    proto.clearRect = function(...args) {
      const result = Reflect.apply(originalClear,this,args);
      try {
        const b = bufferFor(this.canvas);
        const [x,y,w,h] = args;
        const m = this.getTransform();
        if (m.b===0 && m.c===0 && x*m.a+m.e<=0 && y*m.d+m.f<=0 &&
            (x+w)*m.a+m.e>=b.width && (y+h)*m.d+m.f>=b.height) {
          b.items=[]; b.revision=++revision; b.updated=Date.now(); changed();
        }
      } catch (_) { /* Keep native drawing intact. */ }
      return result;
    };
  }

  const canvasProto = window.HTMLCanvasElement?.prototype;
  if (canvasProto) {
    for (const dimension of ['width','height']) {
      const descriptor=Object.getOwnPropertyDescriptor(canvasProto,dimension);
      if (!descriptor?.set || !descriptor.configurable) continue;
      Object.defineProperty(canvasProto,dimension,{
        ...descriptor,
        set(value) {
          Reflect.apply(descriptor.set,this,[value]);
          const b=buffers.get(this);
          if (b) { buffers.delete(this); changed(); }
        }
      });
    }
  }

  function mount() {
    if (!document.body) { setTimeout(mount,20); return; }
    const style = document.createElement('style');
    style.textContent = `
      #wrmb-panel{position:fixed;z-index:1000;box-sizing:border-box;background:var(--wrmb-bg,#1c1c1d);color:var(--wrmb-fg,#d6d6d6);border-radius:10px;display:flex;flex-direction:column;font:13px system-ui;text-align:left;overflow:hidden}
      #wrmb-panel[hidden]{display:none} #wrmb-tools{padding:9px 16px;border-bottom:1px solid #8883;display:flex;gap:8px;flex-wrap:wrap;align-items:center;flex-shrink:0}
      #wrmb-panel button,#wrmb-toggle{font:13px system-ui;color:inherit;background:transparent;border:1px solid #8885;border-radius:16px;padding:5px 12px;cursor:pointer}
      #wrmb-panel button:hover,#wrmb-toggle:hover{background:#8882} #wrmb-title{font-weight:600;margin-right:auto;letter-spacing:.02em}
      #wrmb-status{padding:5px 18px;opacity:.65;font:11px system-ui;flex-shrink:0}
      #wrmb-text{overflow:auto;overflow-anchor:none;overscroll-behavior:contain;padding:16px clamp(18px,5vw,80px) 32px;flex:1;min-height:0;user-select:text;font:var(--wrmb-size,24px)/var(--wrmb-leading,2) 'PingFang SC','Microsoft YaHei',sans-serif;white-space:normal;scrollbar-width:thin;scrollbar-color:#8885 transparent}
      #wrmb-text p{max-width:var(--wrmb-width,38em);margin:0 auto .65em;color:inherit} #wrmb-text hr{border:0;border-top:1px solid #8883;max-width:38em;margin:28px auto}
      #wrmb-toggle{position:fixed;bottom:10px;left:50%;transform:translateX(-50%);z-index:1001;background:var(--wrmb-bg,#1c1c1d);color:var(--wrmb-fg,#d6d6d6)}
      #wrmb-coverage{padding:6px 18px;display:flex;flex-wrap:wrap;gap:12px;align-items:center;font:12px system-ui;flex-shrink:0}#wrmb-coverage span{flex:1}
      #wrmb-scan{padding:10px 18px;font:12px/1.5 system-ui;border-bottom:1px solid #8883;max-height:160px;overflow:auto;flex-shrink:0}#wrmb-scan[hidden]{display:none}#wrmb-scan button{margin:8px 6px 8px 0}
      #wrmb-settings{padding:10px 18px;border-bottom:1px solid #8883;display:flex;gap:16px;flex-wrap:wrap;flex-shrink:0}
      #wrmb-settings[hidden]{display:none} #wrmb-settings label{display:flex;align-items:center;gap:8px;font:12px system-ui} #wrmb-settings input{width:90px;accent-color:#b5a7ee}
      #wrmb-footer{max-width:var(--wrmb-width,38em);margin:24px auto 0;border-top:1px solid #8883;padding-top:16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;font:13px system-ui}
      #wrmb-sentence-hint{font:12px system-ui;opacity:.75;flex:1;min-width:150px} #wrmb-panel button:disabled{opacity:.4;cursor:default}
      @media(max-width:680px){#wrmb-text{font-size:var(--wrmb-size,20px)}#wrmb-tools{gap:4px;padding:7px 10px}#wrmb-panel button{padding:4px 8px}#wrmb-title{width:100%}}
    `;
    document.head.append(style);
    const panel = document.createElement('section');
    panel.id='wrmb-panel'; panel.setAttribute('aria-label','WeRead text bridge');
    const tools=document.createElement('div'); tools.id='wrmb-tools';
    const status=document.createElement('div'); status.id='wrmb-status';
    const coverageBar=document.createElement('div');coverageBar.id='wrmb-coverage';
    const coverageLabel=document.createElement('span');coverageLabel.textContent='Vocabulary coverage · Waiting for Migaku…';coverageBar.append(coverageLabel);
    const scanButton=document.createElement('button');scanButton.textContent='Analyse vocabulary';coverageBar.append(scanButton);
    const saveEpubAction=document.createElement('button');saveEpubAction.textContent='Save as EPUB';coverageBar.append(saveEpubAction);
    const actions=document.createElement('span');actions.style.flex='none';coverageBar.append(actions);
    const actionRoot=actions.attachShadow?actions.attachShadow({mode:'open'}):actions;
    const actionStyle=document.createElement('style');actionStyle.textContent=':host{display:flex;gap:8px;flex:none}button{font:12px system-ui;color:inherit;background:transparent;border:1px solid #8885;border-radius:16px;padding:5px 12px;cursor:pointer}button:hover{background:#8882}';actionRoot.append(actionStyle,scanButton,saveEpubAction);
    const scanBox=document.createElement('div');scanBox.id='wrmb-scan';scanBox.hidden=true;
    // Keep extension parsing out of interactive controls. Migaku otherwise merges
    // adjacent button labels into one sentence and moves them into the last button.
    const scanRoot=scanBox.attachShadow?scanBox.attachShadow({mode:'open'}):scanBox;
    const scanStyle=document.createElement('style');scanStyle.textContent=':host{color:inherit;font:12px/1.5 system-ui}[hidden]{display:none!important}button{display:inline-block;font:12px system-ui;color:inherit;background:transparent;border:1px solid #8885;border-radius:16px;padding:5px 12px;margin:8px 6px 8px 0;cursor:pointer}button:disabled{opacity:.4;cursor:default}';scanRoot.append(scanStyle);
    const scanHelp=document.createElement('div');scanHelp.textContent='This operation rewinds with Previous, then turns forward and waits for Migaku. The standard front cover is excluded. It changes WeRead reading progress. Keep this tab visible. Stop at any time. All chapters are followed using Next. Only accessible text is analysed; loading errors and locked pages produce partial results.';scanRoot.append(scanHelp);
    const scanStart=document.createElement('button');scanStart.textContent='Start from beginning';scanRoot.append(scanStart);
    const scanStop=document.createElement('button');scanStop.textContent='Stop';scanStop.disabled=true;scanRoot.append(scanStop);
    const scanSkip=document.createElement('button');scanSkip.textContent='Skip current page';scanSkip.disabled=true;scanRoot.append(scanSkip);
    const epubButton=document.createElement('button');epubButton.textContent='Download captured EPUB';epubButton.disabled=true;scanRoot.append(epubButton);
    const epubHint=document.createElement('div');epubHint.textContent='EPUB: no text captured yet. Start EPUB capture; download before reloading. A new capture replaces the previous one.';scanRoot.append(epubHint);
    const scanReturn=document.createElement('button');scanReturn.textContent='Return to starting chapter';scanReturn.disabled=true;scanRoot.append(scanReturn);
    const scanLabel=document.createElement('div');scanLabel.textContent='Results count word occurrences, exclude punctuation/ignored words, and keep learning words separate. This is vocabulary coverage, not a guarantee of understanding.';scanRoot.append(scanLabel);
    let selectedWorkflow='vocabulary';
    const alsoLabel=document.createElement('label');alsoLabel.style.display='block';
    const alsoAnalyse=document.createElement('input');alsoAnalyse.type='checkbox';alsoAnalyse.checked=false;
    alsoLabel.append(alsoAnalyse,' Also analyse vocabulary (waits for Migaku)');scanRoot.append(alsoLabel);
    function configureWorkflow(mode) {
      if(!scan)selectedWorkflow=mode;
      const epub=selectedWorkflow==='epub';
      scanBox.hidden=false;alsoLabel.hidden=!epub;alsoAnalyse.disabled=!!scan;
      scanStart.textContent=epub?'Start EPUB capture':'Start vocabulary analysis';
      epubButton.hidden=!epub;epubHint.hidden=!epub;
      scanHelp.textContent=epub?
        'Collect accessible text across all chapters to make an EPUB. Migaku is not required unless you select vocabulary analysis below. A new capture replaces the text held in this tab; download it before reloading.':
        'Read accessible pages across all chapters and wait for Migaku to calculate known-word coverage. This does not collect text for an EPUB.';
      scanHelp.textContent+=' Both operations rewind to the beginning and change WeRead reading progress. Keep this tab visible. Access limits produce partial results.';
    }
    scanButton.addEventListener('click',()=>configureWorkflow('vocabulary'));
    saveEpubAction.addEventListener('click',()=>configureWorkflow('epub'));
    const content=document.createElement('article'); content.id='wrmb-text'; content.lang='zh-CN';
    const settings=document.createElement('div');settings.id='wrmb-settings';settings.hidden=true;
    const defaults={size:24,leading:2,width:38},storageKey='wrmb:reading-preferences:v1';
    let preferences={...defaults};
    try {
      const saved=JSON.parse(localStorage.getItem(storageKey)||'null');
      if(saved && typeof saved==='object') for(const key of Object.keys(defaults)) {
        const bounds={size:[18,36],leading:[1.5,2.8],width:[22,48]}[key];
        if(typeof saved[key]==='number' && Number.isFinite(saved[key])) preferences[key]=Math.min(bounds[1],Math.max(bounds[0],saved[key]));
      }
    } catch (_) { /* Reading remains available when storage is disabled. */ }
    function applyPreferences() {
      panel.style.setProperty('--wrmb-size',preferences.size+'px');
      panel.style.setProperty('--wrmb-leading',String(preferences.leading));
      panel.style.setProperty('--wrmb-width',preferences.width+'em');
    }
    applyPreferences();
    const preferenceInputs=[];
    for(const [key,labelText,min,max,step] of [['size','Text size',18,36,1],['leading','Line spacing',1.5,2.8,.1],['width','Text width',22,48,1]]) {
      const label=document.createElement('label'),input=document.createElement('input'),value=document.createElement('span');
      input.type='range';input.min=String(min);input.max=String(max);input.step=String(step);input.value=String(preferences[key]);
      input.setAttribute('aria-label',labelText);value.textContent=input.value;
      label.append(labelText,input,value);settings.append(label);preferenceInputs.push({key,input,value});
      input.addEventListener('input',()=>{
        clearTimeout(restoreTimer);restoring=null;
        preferences[key]=Math.min(max,Math.max(min,Number(input.value)));value.textContent=String(preferences[key]);applyPreferences();remember();
        try {localStorage.setItem(storageKey,JSON.stringify(preferences));}catch(_){message('Preferences applied for this visit; browser storage is unavailable.');}
      });
    }
    const footer=document.createElement('div');footer.id='wrmb-footer';
    const endLabel=document.createElement('span');endLabel.textContent='End of captured spread';footer.append(endLabel);
    const endNext=document.createElement('button');endNext.textContent='Next →';endNext.setAttribute('aria-label','Next page at end of spread');
    endNext.addEventListener('click',()=>navigate(true));footer.append(endNext);
    const sentenceHint=document.createElement('span');sentenceHint.id='wrmb-sentence-hint';sentenceHint.textContent='Click or select text, then copy its sentence.';footer.append(sentenceHint);
    const copySentence=document.createElement('button');copySentence.textContent='Copy sentence + source';copySentence.disabled=true;footer.append(copySentence);
    let chosenSentence='',displayedSource=null;
    function plainText(node) {
      if(node.nodeType===3)return node.textContent;
      if(node.nodeType===1 && node.matches('rt,rp,.migaku-reading'))return '';
      return Array.from(node.childNodes).map(plainText).join('');
    }
    function sentenceAt(text,offset) {
      if(typeof Intl.Segmenter==='function') {
        const pieces=Array.from(new Intl.Segmenter('zh',{granularity:'sentence'}).segment(text));
        return (pieces.find(p=>offset>=p.index && offset<p.index+p.segment.length)||pieces.at(-1))?.segment.trim()||'';
      }
      const pieces=text.match(/[^。！？!?]+[。！？!?]+[”’」』）)]*|[^。！？!?]+$/g)||[];
      let cursor=0;for(const piece of pieces){cursor+=piece.length;if(offset<cursor)return piece.trim();}
      return pieces.at(-1)?.trim()||'';
    }
    function chooseSentence(event) {
      const paragraph=event.target.closest?.('p');
      if(!paragraph || !content.contains(paragraph) || state!=='reading')return;
      const text=plainText(paragraph),range=document.createRange();let offset=0;
      const selection=window.getSelection();
      range.selectNodeContents(paragraph);
      if(selection?.rangeCount && paragraph.contains(selection.getRangeAt(0).startContainer)) {
        const selected=selection.getRangeAt(0);
        range.setEnd(selected.startContainer,selected.startOffset);offset=plainText(range.cloneContents()).length;
      } else {
        const token=event.target.closest?.('.migaku-token');
        if(token){range.setEndBefore(token);offset=plainText(range.cloneContents()).length;}
      }
      chosenSentence=sentenceAt(text,offset);copySentence.disabled=!chosenSentence;
      sentenceHint.textContent=chosenSentence?'Sentence selected · '+chosenSentence.slice(0,35)+(chosenSentence.length>35?'…':''): 'Select text to choose a sentence.';
    }
    content.addEventListener('mouseup',chooseSentence);
    content.addEventListener('keyup',chooseSentence);
    copySentence.addEventListener('click',async()=>{
      if(!chosenSentence || !displayedSource)return;
      const payload=chosenSentence+'\n\nSource: '+displayedSource.title+'\n'+displayedSource.url;
      try{await navigator.clipboard.writeText(payload);message('Sentence and source copied.');}
      catch(_){message('Clipboard unavailable. Select and copy the sentence manually.');}
    });
    let displayedText='', following=true, timer=0, state='loading', lastActivity=Date.now();
    let snapshotKey='', stableSince=0, restoring=null, restoreTimer=0;
    const coverageId=bookId(location.href);
    let coverage=loadCoverage(coverageId),coverageTimer=0,currentSample=null,scan=null,scanTimer=0;
    let ebookArchive=null;
    function beginEbook() {
      const parts=document.title.replace(/\s*-\s*微信读书\s*$/,'').split(' - ');
      ebookArchive={bookId:coverageId,title:parts[0]||'WeRead book',author:parts.length>=3?parts.at(-1):'',source:location.href,started:Date.now(),complete:false,reason:'Scan in progress.',spreads:[]};
      updateEpub();
    }
    function updateEpub() {
      const n=ebookArchive?.spreads.length||0;epubButton.disabled=!n;
      epubHint.textContent=n?'EPUB: '+n+' captured spreads · '+(ebookArchive.complete?'end reached':'PARTIAL')+' · Export before reloading.':'EPUB: no text captured yet. Start EPUB capture; download before reloading. A new capture replaces the previous one.';
    }
    function captureEbook(sample) {
      if(!ebookArchive || ebookArchive.spreads.some(s=>s.id===sample.id))return;
      const headings=Array.from(document.querySelectorAll('.readerCatalog_list_item_title_text')).map(plainText).map(t=>t.trim()).filter(Boolean);
      const parts=(displayedSource?.title||document.title.replace(/\s*-\s*微信读书\s*$/,'')).split(' - ');
      const chapter=parts.length>=3?parts.slice(1,-1).join(' - '):parts[1]||'Captured text';
      ebookArchive.spreads.push({id:sample.id,chapter,headings,paragraphs:displayedText.split('\n\n').filter(Boolean)});updateEpub();
    }
    epubButton.addEventListener('click',()=>{
      if(!ebookArchive?.spreads.length)return;
      try {
        const bytes=makeEpub(ebookArchive),url=URL.createObjectURL(new Blob([bytes],{type:'application/epub+zip'}));
        const link=document.createElement('a');link.href=url;
        link.download=(ebookArchive.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_')||'WeRead')+(ebookArchive.complete?'_captured':'_PARTIAL')+'.epub';
        document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
        message('EPUB export prepared · '+(ebookArchive.complete?'captured accessible text':'PARTIAL capture')+'.');
      }catch(error){message('EPUB export failed: '+String(error?.message||error));}
    });
    function sampleTokens() {
      if(state!=='reading' || !displayedText)return null;
      const parsed=parsedCount();if(!parsed.total || parsed.complete!==parsed.total)return null;
      const histogram=Object.create(null),words=Object.create(null);
      for(const token of content.querySelectorAll('p .migaku-token')) {
        const status=token.getAttribute('data-mgk-known-status');
        if(!['KNOWN','LEARNING','UNKNOWN','IGNORED'].includes(status))continue;
        const term=token.getAttribute('data-mgk-term') || plainText(token.querySelector('.migaku-surface')||token).trim();
        if(!/[\p{L}\p{N}]/u.test(term))continue;
        const key=JSON.stringify([term,token.getAttribute('data-mgk-term-reading')||'']);
        histogram[key]=(histogram[key]||0)+1;words[key]=status;
      }
      if(!Object.keys(histogram).length)return null;
      return {id:fingerprint(displayedText),histogram,words};
    }
    function renderCoverage() {
      const aggregate=totals(coverage),current=currentSample?totals(coverage,[currentSample.id]):null;
      const complete=coverage.scan?.complete;
      const book=complete?totals(coverage,coverage.scan.ids):aggregate;
      coverageLabel.textContent='Known-word coverage · '+(current?'This spread: '+percentage(current.percent)+' known · ':'')+
        'Book '+(complete?'scanned text: ':coverage.scan?.result==='access-limit'?'preview sample: ':'sample: ')+percentage(book.percent)+' known · '+book.spreads+' spreads';
      coverageLabel.title='Known '+book.KNOWN+' · Learning '+book.LEARNING+' · Unknown '+book.UNKNOWN+' · Ignored '+book.IGNORED+
        '\nRepeated occurrences count. Learning is not counted as known. Saved statuses may become stale. Last analysed: '+(coverage.updated?new Date(coverage.updated).toLocaleString():'not yet');
    }
    function saveCoverage() {
      try {localStorage.setItem(coveragePrefix+coverageId,JSON.stringify(coverage));}
      catch(_){scanLabel.textContent='Browser storage is full or unavailable. Current statistics remain in memory; library badges cannot be saved.';}
      renderCoverage();
    }
    function recordCoverage() {
      const sample=sampleTokens();if(!sample)return null;
      coverage.samples[sample.id]={histogram:sample.histogram};Object.assign(coverage.words,sample.words);
      coverage.updated=Date.now();currentSample=sample;saveCoverage();return sample;
    }
    function queueCoverage() {clearTimeout(coverageTimer);if(scan && !scan.analyse)return;coverageTimer=setTimeout(recordCoverage,500);}
    function available(selector) {return Array.from(document.querySelectorAll(selector)).find(el=>{
      const r=el.getBoundingClientRect(),style=getComputedStyle(el);return r.width>0&&r.height>0&&!el.disabled&&style.visibility!=='hidden'&&style.display!=='none';
    });}
    function accessLimit() {
      // WeRead keeps paywall markup in the DOM even when it is not displayed.
      // Only a visible reading gate is evidence of a restriction.
      if(available('.wr_horizontal_reader_needPay_container'))return true;
      const leaves=Array.from(document.querySelectorAll('.readerChapterContent div,.readerChapterContent span,.readerChapterContent p,.readerChapterContent h1,.readerChapterContent h2,.readerChapterContent button'));
      const text=leaves.filter(el=>{
        if(el.childElementCount || el.closest('rt,rp,.migaku-reading,#wrmb-panel'))return false;
        const r=el.getBoundingClientRect(),style=getComputedStyle(el);
        return r.width>0&&r.height>0&&style.visibility!=='hidden'&&style.display!=='none';
      }).map(el=>el.textContent).join('').replace(/\s+/g,'');
      return /试读结束|购买后(?:即可)?阅读|开通(?:付费)?会员(?:后|即可)(?:继续)?阅读|请(?:先)?购买(?:本书|本章节)/.test(text);
    }
    function showAccessLimit() {
      state='blocked';
      message('Access limit · WeRead requires a subscription or purchase to continue. Previous text remains visible.');
      if(scan) {
        const count=scan.seen.size;
        scanFinished('Preview only: WeRead requires a subscription or purchase to continue. '+count+' spreads processed; this is not a whole-book result.',false,'access-limit');
      }
    }
    function scanPage() {
      const visible=visiblePages();
      const pages=visible.map(({canvas})=>{
        const b=buffers.get(canvas);return b && b.width===canvas.width && b.height===canvas.height?rowsOf(b).map(r=>r.text).join(''):'';
      });
      const images=Array.from(document.querySelectorAll('.readerChapterContent img')).filter(el=>{
        const r=el.getBoundingClientRect();return r.width>30&&r.height>30&&getComputedStyle(el).visibility!=='hidden';
      });
      const raw=pages.join('');
      const cover=!raw && images.some(el=>el.classList.contains('wr_bookCover_img'));
      // Image identities allow the cover to be recognised without parsing text.
      const signature=fingerprint(raw+'|'+images.map(el=>el.getAttribute('src')||'').join('|'));
      return {signature,cover,hasSurface:visible.length>0||images.length>0};
    }
    function scanTurn(forward,page) {
      scan.pending=page.signature;scan.waitSince=Date.now();
      navigate(forward);scanLater(1200);
    }
    function scanFinished(reason,complete=false,result=complete?'complete':'partial') {
      clearTimeout(scanTimer);if(!scan)return;
      if(scan.analyse)coverage.scan={complete,result,ids:[...scan.seen],skipped:scan.skipped,excludedCovers:scan.covers,reason,updated:Date.now()};
      if(scan.capture && ebookArchive){ebookArchive.complete=complete;ebookArchive.reason=reason;updateEpub();}
      scan=null;alsoAnalyse.disabled=false;scanStart.disabled=false;scanStop.disabled=true;scanSkip.disabled=true;scanReturn.disabled=false;
      scanLabel.textContent=reason;saveCoverage();
    }
    function scanLater(ms=700){clearTimeout(scanTimer);scanTimer=setTimeout(()=>{try{scanTick();}catch(error){console.warn('WeRead scan stopped:',error);scanFinished('Partial scan: scanner error — '+String(error?.message||error));}},ms);}
    function scanTick() {
      if(!scan)return;
      if(document.hidden){scanLabel.textContent='Scan paused while this tab is hidden.';scanLater(1500);return;}
      if(accessLimit()){showAccessLimit();return;}
      const age=Date.now()-scan.waitSince;
      // The end-cover element also exists while hidden, so require real visibility.
      const ending=available('.readerFooter_ending');
      const next=available('.renderTarget_pager_button_right');
      if(ending && !next && scan.seen.size) {
        scanFinished(scan.skipped?'Reached the end with skipped pages; result remains partial.':'Reached WeRead’s end screen. Accessible captured text scanned.',scan.skipped===0);return;
      }
      const page=scanPage();
      if(available('.readerCatalog_list_item')) {
        scanLabel.textContent='Close WeRead’s chapter list to continue scanning.';scanLater(1000);return;
      }
      if(!page.hasSurface || Date.now()-lastActivity<700){
        if(age>25000){scanFinished('Partial scan: the reader did not finish loading.');return;}
        scanLabel.textContent='Waiting for WeRead to finish drawing…';scanLater();return;
      }
      if(scan.pending!==null) {
        if(page.signature===scan.pending) {
          if(age>12000){scanFinished('Partial scan: the page-turn control did not change the visible page.');return;}
          scanLabel.textContent=(scan.phase==='rewind'?'Rewinding':'Scanning')+' · Waiting for page turn…';scanLater();return;
        }
        scan.pending=null;scan.waitSince=Date.now();
      }
      if(scan.phase==='rewind') {
        const previous=available('.renderTarget_pager_button:not(.renderTarget_pager_button_right)');
        const next=available('.renderTarget_pager_button_right');
        if(previous) {
          if(scan.rewindSeen.has(page.signature)){scanFinished('Partial scan: rewind encountered a repeated page.');return;}
          scan.rewindSeen.add(page.signature);scan.rewound++;
          scanLabel.textContent='Rewinding to beginning · '+scan.rewound+' turns';scanTurn(false,page);return;
        }
        if(!next){scanFinished('Partial scan: cannot confirm the beginning because page controls are unavailable.');return;}
        scan.phase='page';scan.waitSince=Date.now();scanLabel.textContent='Beginning reached · Starting forward scan…';
      }
      const sample=scan.analyse?sampleTokens():(state==='reading' && displayedText?{id:fingerprint(displayedText)}:null);
      if(page.cover && !available('.renderTarget_pager_button:not(.renderTarget_pager_button_right)') && next) {
        scan.covers++;scanLabel.textContent='Front cover excluded · Moving to the first text page…';scanTurn(true,page);return;
      }
      if(!sample || sample.id===scan.last || Date.now()-lastActivity<700) {
        if(age>25000){scanSkip.disabled=false;scanLabel.textContent='Operation paused: no new ready text. Inspect the page, trigger Migaku parsing if vocabulary analysis is enabled, or skip this page. Skipping keeps the result partial.';scanLater(1500);return;}
        scanLabel.textContent=(scan.capture?'EPUB capture':'Vocabulary analysis')+' · '+scan.seen.size+' spreads · '+(scan.analyse?'Waiting for page/Migaku…':'Waiting for page text…');scanLater();return;
      }
      if(scan.seen.has(sample.id)){scanFinished('Partial scan: a repeated spread was detected.');return;}
      if(scan.analyse)recordCoverage();if(scan.capture)captureEbook(sample);scan.seen.add(sample.id);scan.last=sample.id;
      scanLabel.textContent=(scan.capture?'EPUB capture':'Vocabulary analysis')+' · '+scan.seen.size+' spreads'+(scan.analyse?' · '+percentage(totals(coverage,[...scan.seen]).percent)+' known':' captured');
      if(!next){scanFinished('Partial scan: Next is unavailable and the book end is not confirmed.');return;}
      scanTurn(true,page);
    }
    scanStart.addEventListener('click',event=>{
      event?.stopPropagation?.();
      if(scan)return;
      if(available('.readerCatalog_list_item')){scanLabel.textContent='Close WeRead’s chapter list, then start the scan.';return;}
      following=true;followButton.textContent='Auto: on';
      const capture=selectedWorkflow==='epub',analyse=!capture||alsoAnalyse.checked;
      clearTimeout(coverageTimer);if(capture)beginEbook();alsoAnalyse.disabled=true;
      scan={capture,analyse,phase:'rewind',waitSince:Date.now(),seen:new Set(),rewindSeen:new Set(),rewound:0,last:null,pending:null,skipped:0,covers:0,start:location.href};
      scanReturn.dataset.href=location.href;scanStart.disabled=true;scanStop.disabled=false;scanReturn.disabled=true;
      scanLabel.textContent='Rewinding to the beginning…';scanLater();
    });
    scanStop.addEventListener('click',()=>scanFinished('Partial scan: stopped by you.'));
    scanSkip.addEventListener('click',()=>{
      if(!scan)return;scan.skipped++;scan.last=fingerprint(displayedText);scan.waitSince=Date.now();scanSkip.disabled=true;
      if(available('.renderTarget_pager_button_right')){scanTurn(true,scanPage());}else scanFinished('Partial scan: skipped page has no Next control.');
    });
    scanReturn.addEventListener('click',()=>{if(!scan && scanReturn.dataset.href)location.assign(scanReturn.dataset.href);});
    renderCoverage();
    const positions=new Map();
    function remember() {
      if (!displayedText || restoring!==null) return;
      positions.delete(displayedText);positions.set(displayedText,content.scrollTop);
      if (positions.size>40) positions.delete(positions.keys().next().value);
    }
    content.addEventListener('scroll',remember);
    for(const event of ['wheel','touchstart','pointerdown']) {
      content.addEventListener(event,()=>{clearTimeout(restoreTimer);restoring=null;remember();},{passive:true});
    }
    function message(text) { if (status.textContent!==text) status.textContent=text; }
    function parsedCount() {
      const paragraphs=Array.from(content.querySelectorAll('p'));
      const complete=paragraphs.filter(p=>p.matches('.-mgk-parsed-group,.-mgk-parsed-sentence') ||
        p.querySelector('.-mgk-parsed-group,.-mgk-parsed-sentence')).length;
      const started=complete>0 || !!content.querySelector('.migaku-token,.-mgk-processed');
      return {complete,total:paragraphs.length,started};
    }
    function restorePosition() {
      clearTimeout(restoreTimer);
      if (!restoring) return;
      const now=Date.now(), height=content.scrollHeight;
      if (height!==restoring.height) {restoring.height=height;restoring.stableSince=now;}
      content.scrollTop=restoring.top;
      const parsed=parsedCount();
      const settled=now-restoring.started>=1200 && now-restoring.stableSince>=800;
      const reachable=content.scrollHeight-content.clientHeight>=restoring.top-1;
      // Annotation can alter height after its DOM mutations have already stopped.
      // Retry through layout changes, but never keep fighting a user scroll.
      if ((settled && reachable && parsed.complete===parsed.total && parsed.total>0) || now-restoring.started>=6000) {
        restoring=null;remember();return;
      }
      restoreTimer=setTimeout(restorePosition,100);
    }
    function parsingStatus() {
      if (state!=='reading') return;
      const parsed=parsedCount();
      if (!following) message('Automatic updates paused.');
      else if (parsed.complete===parsed.total && parsed.total>0) message('Ready · Migaku annotations detected · Scroll to read more.');
      else if (parsed.started) message('Migaku is parsing the new text…');
      else message('Text ready · Waiting for Migaku. Trigger its page parsing command if needed.');
      if(restoring) restorePosition();
      queueCoverage();
    }
    const parseObserver=new MutationObserver(parsingStatus);
    parseObserver.observe(content,{childList:true,subtree:true,attributes:true,attributeFilter:['class','data-mgk-known-status']});
    function schedule(delay=180) {
      clearTimeout(timer); timer=setTimeout(()=>{layout();sync();},delay);
    }
    changed=()=>{lastActivity=Date.now();schedule();};
    const button=(label,action)=>{ const b=document.createElement('button'); b.textContent=label; b.addEventListener('click',action); tools.append(b); return b; };
    function visiblePages() {
      return Array.from(document.querySelectorAll('.wr_canvasContainer canvas, .renderTargetContainer canvas'))
        .map(canvas=>({canvas,rect:canvas.getBoundingClientRect()}))
        .filter(({canvas,rect})=>{
          const style=getComputedStyle(canvas);
          return rect.width>80 && rect.height>80 && rect.bottom>0 && rect.top<innerHeight &&
            rect.right>0 && rect.left<innerWidth && style.visibility!=='hidden' && style.display!=='none';
        })
        .sort((a,b)=>a.rect.left-b.rect.left || a.rect.top-b.rect.top);
    }
    function sync(force=false) {
      if ((!following && !force) || document.hidden) return;
      if(accessLimit()){showAccessLimit();return;}
      const visible=visiblePages();
      const ready=visible.map(({canvas})=>{
        const b=buffers.get(canvas);
        return b && b.width===canvas.width && b.height===canvas.height && b.items.length?b:null;
      });
      const key=ready.map(b=>b?.revision||0).join(':');
      if (key!==snapshotKey) { snapshotKey=key;stableSince=Date.now(); }
      if (!ready.length || ready.some(b=>!b)) {
        state='loading';
        message(displayedText?'Loading page · Previous text remains visible.':'Waiting for book text · Turn a page if needed.');
        // A visible empty canvas may be blank or image-only. Refresh permits its omission.
        if (!force || !ready.some(Boolean)) return;
      }
      if (!force && (Date.now()-lastActivity<450 || Date.now()-stableSince<300)) {
        state='loading';message('Loading page · Waiting for the spread to finish drawing…');schedule(350);return;
      }
      const paragraphs=paragraphsOf(ready.filter(Boolean).map(rowsOf));
      const candidate=paragraphs.join('\n\n');
      if (!candidate) return;
      state='reading';
      if (candidate===displayedText) { parsingStatus(); return; }
      remember();
      const fragment=document.createDocumentFragment();
      for (const text of paragraphs) {const p=document.createElement('p');p.textContent=text;fragment.append(p);}
      fragment.append(footer);
      chosenSentence='';copySentence.disabled=true;sentenceHint.textContent='Click or select text, then copy its sentence.';
      displayedSource={title:document.title.replace(/\s*-\s*微信读书\s*$/,''),url:location.href};
      displayedText=candidate;
      clearTimeout(restoreTimer);
      const saved=positions.get(candidate)||0;
      restoring=saved>0?{top:saved,started:Date.now(),height:0,stableSince:Date.now()}:null;
      content.replaceChildren(fragment); content.scrollTop=saved;
      parsingStatus();
    }
    const title=document.createElement('span'); title.id='wrmb-title'; title.textContent='Migaku reading view'; tools.append(title);
    function navigate(forward) {
      const selector=forward?'.renderTarget_pager_button_right':'.renderTarget_pager_button:not(.renderTarget_pager_button_right)';
      const target=Array.from(document.querySelectorAll(selector)).find(el=>{
        const r=el.getBoundingClientRect(); return r.width>0 && r.height>0 && !el.disabled;
      });
      if (target) {remember();state='loading';message('Loading page · Previous text remains visible.');lastActivity=Date.now();target.click();schedule(500);}
      else status.textContent='No page control is available yet. Wait for WeRead to finish loading.';
    }
    button('← Previous',()=>navigate(false));
    button('Next →',()=>navigate(true));
    const followButton=button('Auto: on',()=>{
      following=!following; followButton.textContent=following?'Auto: on':'Auto: paused';
      if (following) sync(true);
      else status.textContent='Automatic updates paused. Click Auto: paused to follow the book again.';
    });
    button('Refresh',()=>sync(true));
    const settingsButton=button('Aa',()=>{
      settings.hidden=!settings.hidden;settingsButton.setAttribute('aria-expanded',String(!settings.hidden));
    });
    settingsButton.setAttribute('aria-label','Reading preferences');settingsButton.setAttribute('aria-expanded','false');
    settingsButton.setAttribute('aria-controls','wrmb-settings');
    tools.append(copySentence);
    button('Copy',async()=>{
      try { await navigator.clipboard.writeText(displayedText); status.textContent='Copied. Automatic page following remains active unless paused.'; }
      catch (_) { status.textContent='Clipboard unavailable. Select and copy the text manually.'; }
    });
    button('Original view',()=>{panel.hidden=true;});
    panel.append(tools,settings,coverageBar,scanBox,status,content); document.body.append(panel);
    const toggle=document.createElement('button'); toggle.id='wrmb-toggle'; toggle.textContent='Migaku / Original';
    toggle.addEventListener('click',()=>{panel.hidden=!panel.hidden;if(!panel.hidden)schedule();}); document.body.append(toggle);
    function layout() {
      const host=document.querySelector('.readerChapterContent') || document.querySelector('.renderTargetContainer');
      if (!host) { panel.style.visibility='hidden'; return; }
      const r=host.getBoundingClientRect();
      const top=Math.max(8,r.top+8), left=Math.max(8,r.left+8);
      let bottom=Math.min(innerHeight-52,r.bottom-72);
      // Always keep the actual original page buttons outside the reading surface.
      for (const el of document.querySelectorAll('.renderTarget_pager_button')) {
        const b=el.getBoundingClientRect();
        if (b.width>0 && b.height>0 && b.top>top) bottom=Math.min(bottom,b.top-12);
      }
      panel.style.visibility=bottom-top<100?'hidden':'visible';
      panel.style.top=top+'px'; panel.style.left=left+'px';
      panel.style.width=Math.max(0,Math.min(innerWidth-8,r.right-8)-left)+'px';
      panel.style.height=Math.max(0,bottom-top)+'px';
      const nativeNext=Array.from(document.querySelectorAll('.renderTarget_pager_button_right')).find(el=>{
        const r=el.getBoundingClientRect();return r.width>0 && r.height>0 && !el.disabled;
      });
      endNext.disabled=!nativeNext;
      const theme=getComputedStyle(host);
      if (theme.backgroundColor && theme.backgroundColor!=='rgba(0, 0, 0, 0)' && theme.backgroundColor!=='transparent') {
        panel.style.setProperty('--wrmb-bg',theme.backgroundColor);
        toggle.style.setProperty('--wrmb-bg',theme.backgroundColor);
      }
      if (theme.color) {
        panel.style.setProperty('--wrmb-fg',theme.color);
        toggle.style.setProperty('--wrmb-fg',theme.color);
      }
    }
    // Ignore Migaku's annotation churn; watch only reader structure/layout changes.
    const readerObserver=new MutationObserver(records=>{
      const relevant=records.some(record=>{
        const el=record.target.nodeType===1?record.target:record.target.parentElement;
        if (el?.closest('#wrmb-panel')) return false;
        if (record.type==='attributes') return el?.matches('body,html,.readerChapterContent,.renderTargetContainer,.wr_canvasContainer,canvas,.wr_horizontal_reader_needPay_container');
        return [...record.addedNodes,...record.removedNodes].some(n=>n.nodeType===1 &&
          (n.matches('canvas,.readerChapterContent,.renderTargetContainer,.wr_canvasContainer') || n.querySelector('canvas')));
      });
      if(relevant) schedule();
    });
    readerObserver.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class','style']});
    window.addEventListener('resize',()=>schedule());
    window.addEventListener('scroll',()=>schedule(),{passive:true});
    window.addEventListener('popstate',()=>schedule());
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)schedule();});
    // Lightweight fallback handles cached pages even when no drawing call fires.
    let lastCheck='';
    setInterval(()=>{
      if(document.hidden || !following || panel.hidden) return;
      const key=visiblePages().map(({canvas,rect})=>`${buffers.get(canvas)?.revision||0}:${rect.left}:${rect.top}:${rect.width}:${rect.height}`).join('|');
      if(key!==lastCheck){lastCheck=key;schedule();}
    },1500);
    status.textContent='Waiting for the first page to finish drawing.';
    layout(); sync();
  }
  mount();
})();