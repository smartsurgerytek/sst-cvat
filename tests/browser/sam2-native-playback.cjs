// SPDX-License-Identifier: MIT
// CVAT_BROWSER_TEST_DEPS=/path/to/playwright-project node tests/browser/sam2-native-playback.cjs
const fs = require('fs');
const assert = require('assert/strict');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const webpack = require('webpack');
const { chromium } = require(require.resolve('playwright-core', {
 paths: [process.env.CVAT_BROWSER_TEST_DEPS || process.cwd()],
}));
const root = path.resolve(__dirname, '../..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sam2-native-playback-'));
async function prepare() {
 execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
  'testsrc2=size=1920x1080:rate=25', '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast',
  '-g', '60', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', path.join(directory, 'video.mp4')]);
 execFileSync(process.env.PYAV_PYTHON || 'python3', [path.join(__dirname, 'create_sam2_segments.py'), directory], {stdio:'inherit'});
 await new Promise((resolve, reject) => webpack({
  mode: 'development', devtool: false, entry: path.join(__dirname, 'sam2-native-playback-entry.tsx'),
  output: { path: directory, filename: 'playback.js' },
  resolve: { extensions: ['.tsx', '.ts', '.js'], modules: [path.join(root, 'node_modules')],
   alias: { utils: path.join(root, 'cvat-ui/src/utils') } },
  module: { rules: [{ test: /\.tsx?$/, use: path.join(__dirname, 'typescript-loader.cjs') }] },
 }, (error, stats) => error || stats.hasErrors() ? reject(error || new Error(stats.toString({all:false,errors:true}))) : resolve()));
}
(async()=>{
 await prepare();
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || '/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 try {
  const context=await browser.newContext({viewport:{width:1280,height:900}});
  const page=await context.newPage();const requests=[];const errors=[];
  await page.addInitScript(()=>{
   window.overlaySamples=[];
   const original=HTMLVideoElement.prototype.requestVideoFrameCallback;
   HTMLVideoElement.prototype.requestVideoFrameCallback=function(callback){
    return original.call(this,(now,metadata)=>{
     callback(now,metadata);
     const canvas=document.querySelector('.cvat-sam2-continuous-playback canvas');
     if(canvas?.dataset.frame)window.overlaySamples.push({time:metadata.mediaTime,frame:Number(canvas.dataset.frame)});
    });
   };
  });
  const clips=JSON.parse(fs.readFileSync(path.join(directory,'original-segments.json')));
  page.on('pageerror',e=>errors.push(e.message));
  let blockNetwork=false;let provideScores=false;
  await page.route('http://playback.test/**',async route=>{
   const url=new URL(route.request().url());requests.push(url.pathname);
   if(blockNetwork) return route.abort('internetdisconnected');
   const match=/\/video.mp4\/segments\/(\d+)$/.exec(url.pathname);
   if(match){
    const index=Number(match[1]);const clip=clips[index];
    const body=fs.readFileSync(path.join(directory,`original-${index}.mp4`));
    // Simulate 64 Mbps plus a 5.5-second server delay on segment 2.
    // One-segment lookahead would exhaust its buffer at the 10-second boundary.
    await new Promise(r=>setTimeout(r,body.length/(8*1024*1024)*1000 + (index === 2 ? 5500 : 0)));
    return route.fulfill({headers:{'Content-Type':'video/mp4','X-Video-Start':String(clip.start),
     'X-Video-End':String(clip.end),'X-Video-Codec':clip.codec},body}).catch(()=>{});
   }
   if(url.pathname==='/video.mp4') return route.abort();
   const object=frame=>({object_id:'one',shape_id:null,label_id:1,label_name:'object',label_color:'#00ff00',
    points:[0,300000,100+frame,100,699+frame,599],version:null});
   if(url.pathname.endsWith('/playback'))return route.fulfill({contentType:'application/json',body:JSON.stringify({
    width:1920,height:1080,frames:Array.from({length:300},(_,frame)=>({frame,objects:[object(frame)]})),
   })});
   if(url.pathname.endsWith('/masks')){const frame=Number(url.searchParams.get('frame'));
    const mask=object(frame);
    const compact=url.searchParams.get('preview')==='1';
    const scale=compact?6:1,width=1920/scale,height=1080/scale;
    const left=Math.ceil((100+frame)/scale),right=Math.floor((699+frame)/scale);
    const top=Math.ceil(100/scale),bottom=Math.floor(599/scale);
    if(compact)mask.points=[0,(right-left+1)*(bottom-top+1),left,top,right,bottom];
    if(provideScores){
     const values=new Float32Array(width*height).fill(-2);
     for(let y=top;y<=bottom;y++)values.fill(2,y*width+left,y*width+right+1);
     mask.logits=Buffer.from(values.buffer).toString('base64');
    }
    await new Promise(resolve=>setTimeout(resolve,1000));
    return route.fulfill({
    contentType:'application/json',body:JSON.stringify({frame,width,height,objects:[mask]}),
   }).catch(()=>{});}
   return route.fulfill({contentType:'text/html',body:'<div id="root"></div>'});
  });
  const open=async frame=>{
   await page.goto(`http://playback.test/?frame=${frame}`);
   await page.addScriptTag({content:fs.readFileSync(path.join(directory,'playback.js'),'utf8')});
   await page.getByText('Adjusting object · one', {exact:true}).waitFor();
   await page.getByRole('button',{name:'Play',exact:true}).click();
   await page.locator('video').waitFor();
  };
  await open(0);
  await page.evaluate(()=>{
   const video=document.querySelector('video');window.metrics={samples:[],seeks:0};
   video.addEventListener('seeking',()=>window.metrics.seeks++);
   const tick=(now,meta)=>{window.metrics.samples.push({now,time:meta.mediaTime});video.requestVideoFrameCallback(tick);};
   video.requestVideoFrameCallback(tick);
  });
  await page.waitForFunction(()=>document.querySelector('video')?.currentTime>8,{timeout:40000});
  // Third segment is now cached. Drop all new network requests and keep playing.
  const callsAtDisconnect=requests.length;
  blockNetwork=true;
  await page.waitForFunction(()=>window.metrics.samples.some(x=>x.time>11.5),{timeout:7000});
  const metrics=await page.evaluate(()=>window.metrics);
  const overlaySamples=await page.evaluate(()=>window.overlaySamples.filter(sample=>sample.time>0.2&&sample.time<11.5));
  assert(overlaySamples.length>200,'insufficient presented-frame samples');
  assert.deepEqual(overlaySamples.filter(sample=>sample.frame!==Math.floor(sample.time*25+0.00001)),[],
   'mask frame differs from presented video frame');
  assert.equal(requests.length,callsAtDisconnect,'network needed during cached playback');
  const samples=metrics.samples.filter(x=>x.time>0.2&&x.time<11.5);
  const gaps=samples.slice(1).map((x,i)=>x.now-samples[i].now).sort((a,b)=>a-b);
  assert(Math.max(...gaps)<300,`stall across segment boundary: ${Math.max(...gaps)}`);
  assert(metrics.seeks<=1,`per-segment seeks: ${metrics.seeks}`);
  const fetched=requests.filter(x=>x.includes('/segments/'));
  assert.deepEqual(fetched,['/video.mp4/segments/0','/video.mp4/segments/1','/video.mp4/segments/2']);
  assert(!requests.includes('/video.mp4'),'downloaded entire original');
  blockNetwork=false;
  // Reload and seek directly to a cached later segment; IndexedDB must survive reload.
  await open(250);
  await page.waitForFunction(()=>document.querySelector('video')?.currentTime>10.5,{timeout:5000});
  assert.equal(requests.filter(x=>x.includes('/segments/')).length,3,'cached segment re-downloaded');
  // Full mask details are deliberately delayed; resuming cached video must not wait for them.
  const pausedMaskRequest=page.waitForRequest(request=>new URL(request.url()).pathname.endsWith('/masks'));
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  await pausedMaskRequest;
  const resume=page.getByRole('button',{name:'Play',exact:true});
  assert.equal(await resume.isDisabled(),false,'Play locked while paused mask details load');
  const pausedTime=await page.locator('video').evaluate(video=>video.currentTime);
  await resume.click();
  await page.waitForFunction(time=>{
   const video=document.querySelector('video');return !video.paused && video.currentTime>time+0.1;
  },pausedTime);
  // Pausing/seeking within downloaded video must clear transient buffering.
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  await page.waitForFunction(()=>{
   const video=document.querySelector('video');
   return video.paused && !video.seeking && video.readyState>=2;
  });
  await page.waitForFunction(()=>!document.body.textContent.includes('Buffering video'));
  const frameSlider=page.locator('.cvat-sam2-mask-review .ant-slider').first().getByRole('slider');
  provideScores=true;
  await frameSlider.focus();await frameSlider.press('End');
  const strength=page.getByRole('spinbutton',{name:'Sampling strength value'});
  const passes=page.getByRole('spinbutton',{name:'Smoothing iterations value'});
  assert.equal(await strength.isDisabled(),false,'sampling locked while frame details load');
  assert.equal(await passes.isDisabled(),false,'smoothing locked while frame details load');
  await strength.fill('2.5');await passes.fill('3');await passes.press('Tab');
  await page.waitForFunction(()=>{
   const video=document.querySelector('video');
   return video.paused && !video.seeking && video.readyState>=2;
  });
  await page.waitForFunction(()=>!document.body.textContent.includes('Buffering video'));
  assert.equal(await strength.inputValue(),'2.50');
  assert.equal(requests.filter(x=>x.includes('/segments/')).length,3,'paused seek re-downloaded cached video');
  // Paused threshold and smoothing must share the editor's full-resolution mask.
  await page.locator('.cvat-sam2-advanced > summary').click();
  await page.waitForFunction(()=>document.querySelector('.cvat-sam2-advanced .ant-slider')?.classList.contains('ant-slider-disabled')===false);
  await page.getByRole('button',{name:'Reset preview',exact:true}).click();
  const overlay=page.locator('.cvat-sam2-continuous-playback canvas');
  const original=await overlay.evaluate(canvas=>canvas.toDataURL());
  const threshold=page.locator('.cvat-sam2-advanced .ant-slider').first().getByRole('slider');
  await threshold.focus();for(let i=0;i<10;i++)await threshold.press('ArrowRight');
  await page.waitForFunction(()=>!document.body.textContent.includes('Loading adjusted overlay'));
  assert.equal(await overlay.evaluate(canvas=>canvas.toDataURL()),original,'threshold preview lost full-resolution edges');
  await strength.fill('5');await passes.fill('3');await passes.press('Tab');
  assert.notEqual(await overlay.evaluate(canvas=>canvas.toDataURL()),original,'threshold prevented corner smoothing');
  await strength.fill('0');await passes.fill('0');await passes.press('Tab');
  assert.equal(await overlay.evaluate(canvas=>canvas.toDataURL()),original,'zero smoothing did not restore threshold-only mask');
  provideScores=false;
  await open(0);
  await page.waitForFunction(()=>document.querySelector('video')?.currentTime>0.5);
  assert.equal(requests.filter(x=>x.includes('/segments/')).length,3,'backward seek re-downloaded cached video');
  await page.evaluate(()=>new Promise((resolve,reject)=>{
   const request=indexedDB.deleteDatabase('cvat-sam2-playback-v1');
   request.onsuccess=resolve;request.onerror=()=>reject(request.error);
  }));
  await open(250);
  await page.waitForFunction(()=>document.querySelector('video')?.currentTime>10.5,{timeout:7000});
  assert.deepEqual(requests.filter(x=>x.includes('/segments/')),
   [...fetched,'/video.mp4/segments/2'],'uncached seek downloaded earlier segments');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:'PASS',networkMbps:64,segment2ExtraDelayMS:5500,source:'1080p25',video:'shared original segments',
   fetchedSegments:[0,1,2],fullOriginalDownloads:0,seeks:metrics.seeks,
   maxFrameGapMS:Math.round(Math.max(...gaps)),p95FrameGapMS:Math.round(gaps[Math.floor(gaps.length*.95)]),
   thresholdThenSmoothing:'full-resolution and reversible',overlaySynchronization:'every presented frame matched',offlinePlayback:'passed',reloadSeekTo10Seconds:'cache hit',uncachedSeekTo10Seconds:'only segment 2 downloaded'}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>fs.rmSync(directory,{recursive:true,force:true}));
