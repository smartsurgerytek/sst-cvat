import React from 'react';
import { createRoot } from 'react-dom/client';
import Review from '../../cvat-ui/src/components/annotation-page/top-bar/sam2-mask-review';
import { registerOriginalVideo } from '../../cvat-core/src/original-video';
registerOriginalVideo(4,{id:'native',project_id:1,filename:'test.mp4',duration:12,timestamps:Array.from({length:300},(_,i)=>i/25),url:'/video.mp4'});
(window as any).frameLoads=[];
const job = {id:4,frames:{get:async(frame:number)=>({data:async()=>{
 (window as any).frameLoads.push({frame,time:performance.now()});
 const canvas=document.createElement('canvas');canvas.width=1920;canvas.height=1080;
 return {imageData:await createImageBitmap(canvas)};
}})},annotations:{hasUnsavedChanges:()=>false}};
createRoot(document.getElementById('root')!).render(<Review job={job as any} base='/api/jobs/4/video-inference' run={{id:'test',status:'ready',start_frame:0,stop_frame:299}} initialFrame={Number(new URLSearchParams(location.search).get('frame') || 0)} resultsRevision={0} onChanged={async()=>{}}/>);
