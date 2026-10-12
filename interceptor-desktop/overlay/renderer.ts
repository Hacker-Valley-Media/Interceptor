// This TypeScript source deliberately uses executable ECMAScript syntax:
// the native webviews embed it directly without an additional runtime compiler.
(() => {
  "use strict";
  const cfg = window.__itcOverlayConfig;
  const spec = window.__itcOverlaySpec;
  const canvas = document.createElement("canvas");
  document.documentElement.style.cssText = "background:transparent;width:100%;height:100%;overflow:hidden";
  document.body.style.cssText = "margin:0;background:transparent;width:100%;height:100%;overflow:hidden";
  canvas.style.cssText = "display:block;width:100%;height:100%;background:transparent";
  document.body.replaceChildren(canvas);
  const ctx = canvas.getContext("2d", {alpha:true});
  if (!ctx) throw new Error("native webview has no Canvas2D renderer");
  const entities = new Map(), shapes = new Map();
  let effects = [], tweens = [], timeline = [], particles = [], elapsed = 0, last = 0, frame = 0;
  let paused = false, retired = false, lastError = null, banner = {text:"",y:0.92,fontSize:36,color:"white"};
  let width = 1, height = 1, background = "transparent", emission = 0, sceneRound = 1, nextRound = 0;
  let trackingObservation=null,trackingMisses=0;
  const presetEmojis = {roses:["🌹"],hearts:["❤️","💕"],petals:["🌸","🌺"],stars:["⭐","✨"],snow:["❄️"],confetti:["🎊","🎉"],titans:["🦍","🦖"],fire:["🔥"],beams:["✨"],custom:["✨"]};
  const settings = {density:cfg.density??12,lifetime:cfg.lifetime??5,velocity:cfg.velocity??100,scale:cfg.size_scale??1,direction:cfg.direction??"down",emojis:Array.isArray(cfg.emojis)?cfg.emojis:typeof cfg.emojis==="string"?cfg.emojis.split(",").map(s=>s.trim()):presetEmojis[cfg.particles]??["✨"]};
  const fail = (code,message) => {const error=new Error(message);error.code=code;throw error;};
  const number = (v, fallback) => typeof v === "number" && Number.isFinite(v) ? v : fallback;
  const color = c => c??"white";
  const countNodes = () => entities.size + shapes.size + effects.length + particles.length + tweens.length;
  const admit = n => {if(countNodes()+n>spec.limits.nodes)fail("resource_limit","renderer live-node budget exceeded");};
  function resize() {
    const ratio=Math.min(2,window.devicePixelRatio||1),w=Math.max(1,Math.round(innerWidth*ratio)),h=Math.max(1,Math.round(innerHeight*ratio));
    if(w>16384||h>16384||w*h>spec.limits.pixels)fail("resource_limit","renderer backing pixel budget exceeded");
    width=innerWidth;height=innerHeight;canvas.width=w;canvas.height=h;ctx.setTransform(ratio,0,0,ratio,0,0);
  }
  resize();window.addEventListener("resize",()=>{try{resize();}catch(e){lastError={code:e.code??"provider_failed",error:String(e.message).slice(0,1024)};paused=true;}});
  function spawn(row) {
    if(!entities.has(row.id)){if(entities.size>=spec.limits.entities)fail("resource_limit","entity limit exceeded");admit(1);}
    tweens=tweens.filter(t=>t.id!==row.id);
    entities.set(row.id,{id:row.id,emoji:row.emoji??"✨",x:row.x??0.5,y:row.y??0.5,size:row.size??96,facing:row.facing??"right",angle:0,scale:1,alpha:1,tint:null,tintAmount:0,dx:0,dy:0});
  }
  function targets(target) {
    const ids=target==="all"?[...entities.keys()]:Array.isArray(target)?target:[target];
    if(ids.some(id=>!entities.has(id)))fail("target_gone","scene operation targets an absent entity");
    return ids.map(id=>entities.get(id));
  }
  function tween(e, values, duration, easing="linear", loop=false, repeat=false) {
    const keys=Object.keys(values);tweens=tweens.filter(t=>t.id!==e.id||!t.keys.some(k=>keys.includes(k)));
    admit(1);const from=Object.fromEntries(keys.map(k=>[k,e[k]]));tweens.push({id:e.id,keys,from,values,duration:Math.max(0.001,duration),at:elapsed,easing,loop,repeat});
  }
  function effect(row) {admit(1);effects.push({...row,at:elapsed,duration:row.duration??0.8});}
  function burst(x,y,emojis,count=18,spread=180,lifetime=1.2) {
    if(count<1||count>128||!Number.isInteger(count))fail("invalid_request","burst requires1..128 particles");admit(count);
    for(let i=0;i<count;i++){const angle=Math.random()*Math.PI*2,speed=spread*(0.25+Math.random()*0.75);effect({kind:"emoji",emoji:emojis[i%emojis.length],x,y,vx:Math.cos(angle)*speed,vy:Math.sin(angle)*speed,size:24+Math.random()*20,duration:lifetime});}
  }
  function remove(id) {if(!entities.delete(id))fail("target_gone","scene entity is absent");tweens=tweens.filter(t=>t.id!==id);}
  function append(ops,relative=true) {
    if(timeline.length+ops.length>spec.limits.operations)fail("resource_limit","retained timeline exceeds4096 operations");
    timeline.push(...ops.map(op=>({...op,at:(op.at??0)+(relative?elapsed:0),complete:false})));
    timeline.sort((a,b)=>a.at-b.at);
  }
  function load(script, merge=false) {
    if(!merge){entities.clear();shapes.clear();effects=[];tweens=[];timeline=[];elapsed=0;emission=0;lastError=null;background="transparent";banner={text:"",y:0.92,fontSize:36,color:"white"};}
    const newIds=(script.entities??[]).filter(e=>!entities.has(e.id));
    if(entities.size+newIds.length>spec.limits.entities||timeline.length+(script.timeline?.length??0)>spec.limits.operations)fail("resource_limit","appended script exceeds retained entity/timeline bounds");
    admit(newIds.length);
    if(script.background!==undefined)background=script.background;
    if(script.banner)banner={...banner,...script.banner};
    for(const row of script.entities??[])spawn(row);
    append(script.timeline??[],merge);
  }
  function point(row, prefix) {
    const id=row[prefix];if(id!==undefined){const e=targets(id)[0];return[e.x,e.y];}
    return[row[prefix+"X"],row[prefix+"Y"]];
  }
  function execute(op) {
    const duration=number(op.duration,0.6),at=elapsed;
    let selected=[];if(op.target!==undefined)selected=targets(op.target);
    switch(op.op){
      case"idle-bob":for(const e of selected)tween(e,{dy:number(op.amplitude,12)},duration,"easeInOut",true,true);break;
      case"move-to":for(const e of selected)tween(e,{x:op.x??e.x,y:op.y??e.y},duration,op.easing);break;
      case"move-by":for(const e of selected)tween(e,{x:e.x+(op.dx??0),y:e.y+(op.dy??0)},duration,op.easing);break;
      case"rotate-to":for(const e of selected)tween(e,{angle:op.angle??0},duration);break;
      case"rotate-by":for(const e of selected)tween(e,{angle:e.angle+(op.angle??0)},duration);break;
      case"scale-to":for(const e of selected)tween(e,{scale:op.scale??1},duration);break;
      case"fade-to":for(const e of selected)tween(e,{alpha:op.alpha??1},duration);break;
      case"tint":for(const e of selected){e.tint=color(op.color);e.tintAmount=op.amount??0.7;}break;
      case"set-facing":for(const e of selected)e.facing=op.dir??"right";break;
      case"throw":{const[fromX,fromY]=point(op,"from"),[toX,toY]=point(op,"to");effect({kind:"projectile",emoji:op.emoji??"🪨",x:fromX,y:fromY,toX,toY,size:48,duration:0.7,hitColor:op.hitColor??"orange"});break;}
      case"impact":burst(op.x??0.5,op.y??0.5,["💥","✨"],24,180,0.65);if(op.text)effect({kind:"text",text:op.text,x:op.x??0.5,y:op.y??0.5,size:48,color:"yellow"});break;
      case"burst":burst(op.x??0.5,op.y??0.5,Array.isArray(op.emojis)?op.emojis:typeof op.emojis==="string"?op.emojis.split(","):["✨"],op.count??18,op.spread??180,op.lifetime??1.2);break;
      case"say":banner.text=op.text??"";break;
      case"text":effect({kind:"text",text:op.text??"",x:op.x??0.5,y:op.y??0.5,size:op.fontSize??36,color:color(op.color),duration});break;
      case"label":case"rect":{const id=op.id??"shape-"+frame+"-"+shapes.size;if(!shapes.has(id)){if(shapes.size>=256)fail("resource_limit","shape limit exceeded");admit(1);}shapes.set(id,{...op,id});break;}
      case"clear-shapes":shapes.clear();break;
      case"shake":if(selected.length){for(const e of selected)tween(e,{dx:op.magnitude??10},duration,"linear",true);}else effect({kind:"shake",magnitude:op.magnitude??10,duration});break;
      case"knockout":for(const e of selected){tween(e,{angle:-1.5,alpha:0.4},0.8);burst(e.x,e.y,["💥","⭐"],32,220,1);}break;
      case"roar":for(const e of selected){tween(e,{scale:1.15},0.6,"easeInOut",true);effect({kind:"text",text:op.text??"ROAR!",x:e.x,y:Math.min(1,e.y+0.15),size:40,color:"yellow",duration:1.2});}break;
      case"bow":for(const e of selected)tween(e,{angle:e.facing==="right"?-0.45:0.45},0.7,"easeInOut",true);break;
      case"jump":for(const e of selected)tween(e,{dy:op.height??120},0.8,"easeInOut",true);break;
      case"spawn":spawn(op.entity);break;
      case"despawn":remove(op.target);break;
      case"wait":break;
      default:fail("invalid_request","unknown renderer operation");
    }
  }
  function fighter(who) {return["g","gz","godzilla"].includes(String(who??"kong").toLowerCase())?"godzilla":"kong";}
  function sceneControl(verb,args) {
    const id=fighter(args.who),other=id==="kong"?"godzilla":"kong",e=targets(id)[0];
    switch(verb){
      case"say":banner.text=args.text;break;
      case"round":sceneRound=args.n??sceneRound+1;banner.text=args.text??"ROUND "+sceneRound;break;
      case"punch":effect({kind:"projectile",emoji:args.emoji??"👊",x:e.x,y:e.y,toX:targets(other)[0].x,toY:targets(other)[0].y,size:48,duration:0.25});break;
      case"breathe-fire":for(let i=0;i<24;i++)effect({kind:"projectile",emoji:args.emoji??"🔥",x:e.x,y:e.y,toX:targets(other)[0].x,toY:targets(other)[0].y,size:24+Math.random()*24,duration:0.4+Math.random()*0.5});break;
      case"throw":execute({op:"throw",from:id,to:other,emoji:args.emoji??"🪨"});break;
      case"taunt":execute({op:"shake",target:id,magnitude:15,duration:0.6});break;
      case"roar":case"bow":case"jump":case"knockout":case"tint":execute({op:verb,target:id,...args});break;
      case"reset":initScene();break;
      default:fail("invalid_request","unknown fighter control");
    }
  }
  function initScene() {
    load({banner:{text:"TITANS",y:0.9,fontSize:48,color:"white"},entities:[{id:"kong",emoji:"🦍",x:0.3,y:0.25,size:160,facing:"right"},{id:"godzilla",emoji:"🦖",x:0.7,y:0.25,size:160,facing:"left"}]});
    nextRound=elapsed+3;sceneRound=1;
  }
  function status() {return{paused,retired,frames:frame,elapsed,backingWidth:canvas.width,backingHeight:canvas.height,entityCount:entities.size,shapeCount:shapes.size,nodeCount:countNodes(),pendingOperations:timeline.filter(o=>!o.complete).length,timelineCount:timeline.length,lastRuntimeError:lastError,trackingObservation,...(cfg.mode==="particles"?{...settings,liveParticles:particles.length}:{}),...(cfg.mode==="scene"?{round:sceneRound}:{}),entities:[...entities.values()].map(e=>({id:e.id,x:e.x,y:e.y,emoji:e.emoji,size:e.size,facing:e.facing,angle:e.angle,scale:e.scale,alpha:e.alpha}))};}
  function track(data,display,overlay) {
    try {
      if(retired||cfg.mode!=="scene-script")fail("target_gone","tracking renderer is unavailable");
      if(!display||!overlay||[display.x,display.y,display.width,display.height,overlay.x,overlay.y,overlay.width,overlay.height].some(n=>typeof n!=="number"||!Number.isFinite(n))||overlay.width<=0||overlay.height<=0)fail("unsupported_target","tracking requires actual display and overlay geometry");
      const faces=data.faces??[],face=[...faces].sort((a,b)=>b.width*b.height-a.width*a.height)[0];
      trackingObservation={frames:data.frames,capturedWidth:data.capturedWidth,capturedHeight:data.capturedHeight,intervalSeconds:data.intervalSeconds,requestedFPS:data.requestedFPS,unavailable:data.unavailable,faceCount:faces.length};
      if(face) {
        const pad=0.15,rx=Math.max(0,face.x-face.width*pad),ry=Math.max(0,face.y-face.height*pad),rw=Math.min(1-rx,face.width*1.3),rh=Math.min(1-ry,face.height*1.3);
        const left=(display.x+rx*display.width-overlay.x)/overlay.width,top=(display.y+(1-ry-rh)*display.height-overlay.y)/overlay.height;
        const w=rw*display.width/overlay.width,h=rh*display.height/overlay.height;
        if(left+w>0&&top+h>0&&left<1&&top<1) {
          const needed=Number(!shapes.has("face-box"))+Number(!shapes.has("face-label"));if(shapes.size+needed>256)fail("resource_limit","tracking shape admission exceeds256");admit(needed);
          // Rect coordinates in the retained scene use bottom-left y. The
          // native display/overlay mapping first produces its top-left edge.
          shapes.set("face-box",{op:"rect",id:"face-box",x:left,y:1-top,width:w,height:h,color:"red",lineWidth:5,cornerRadius:6});
          shapes.set("face-label",{op:"label",id:"face-label",x:left+w/2,y:1-top-h-22/height,text:"Face "+Math.round(face.confidence*100)+"%",color:"red",fontSize:28});trackingMisses=0;
        }else trackingMisses++;
      }else trackingMisses++;
      if(trackingMisses>=5){shapes.delete("face-box");shapes.delete("face-label");}
      paint(0);return{success:true,data:{ok:true,fps:data.requestedFPS,trackingObservation}};
    }catch(e){return{success:false,code:e.code??"provider_failed",error:String(e.message).slice(0,1024)};}
  }
  function control(verb,args) {
    // Controllers change only this retained canvas model. Restore its bounded
    // state if a later admission check fails, before returning a failure.
    const saved={entities:new Map([...entities].map(([id,e])=>[id,{...e}])),shapes:new Map(shapes),effects:[...effects],tweens:[...tweens],timeline:timeline.map(o=>({...o})),particles:[...particles],settings:{...settings},elapsed,emission,sceneRound,nextRound,paused,last,lastError,background,banner:{...banner}};
    try{
      if(retired)fail("target_gone","renderer is retired");
      if(!Object.hasOwn(spec.controls[cfg.mode]??{},verb))fail("invalid_request","unknown controller verb");
      if(verb==="pause"){paused=true;return{success:true,data:{ok:true,...status()}};}
      if(verb==="resume"){paused=false;last=performance.now()/1000;return{success:true,data:{ok:true,...status()}};}
      if(cfg.mode==="particles"){
        const keys={"set-density":"density","set-direction":"direction","set-emojis":"emojis","set-lifetime":"lifetime","set-velocity":"velocity","set-scale":"scale"};
        if(verb==="burst"){const rate=settings.density*(args.count??40);if(rate>512)fail("resource_limit","particle burst emission exceeds512/s");const n=Math.max(1,Math.min(128,Math.ceil(rate*0.25)));admit(n);for(let i=0;i<n;i++)emitParticle();}
        else{const proposed={...settings,[keys[verb]]:verb==="set-emojis"?(Array.isArray(args.value)?args.value:args.value.split(",").map(s=>s.trim())):args.value};if(proposed.density*proposed.lifetime>spec.limits.portableParticles)fail("resource_limit","portable particle density/lifetime exceeds1888");Object.assign(settings,proposed);}
      }else if(cfg.mode==="scene")sceneControl(verb,args);
      else switch(verb){
        case"append-ops":append(args.ops,args.relative??true);break;
        case"append-script":load(args.json,true);break;
        case"say":banner.text=args.text;break;
        case"reset":elapsed=0;timeline.forEach(o=>o.complete=false);tweens=[];effects=[];lastError=null;break;
        case"clear-entities":entities.clear();tweens=[];break;
        case"spawn":spawn(args.entity);break;
        case"despawn":remove(args.id);break;
        case"face-track-start":fail("unsupported_operation","tracking startup requires the retained native controller");break;
        case"face-track-stop":return{success:true,data:{ok:true,tracking:false}};
      }
      return{success:true,data:{ok:true,...status()}};
    }catch(e){
      entities.clear();for(const[id,entity]of saved.entities)entities.set(id,entity);shapes.clear();for(const[id,shape]of saved.shapes)shapes.set(id,shape);
      effects=saved.effects;tweens=saved.tweens;timeline=saved.timeline;particles=saved.particles;Object.assign(settings,saved.settings);
      elapsed=saved.elapsed;emission=saved.emission;sceneRound=saved.sceneRound;nextRound=saved.nextRound;paused=saved.paused;last=saved.last;lastError=saved.lastError;background=saved.background;banner=saved.banner;
      return{success:false,code:e.code??"provider_failed",error:String(e.message).slice(0,1024)};
    }
  }
  function emitParticle() {
    admit(1);const s=settings,dir=s.direction,vertical=dir==="up"||dir==="down";
    particles.push({emoji:s.emojis[Math.floor(Math.random()*s.emojis.length)],x:vertical?Math.random()*width:dir==="left"?width+32:-32,y:vertical?(dir==="up"?height+32:-32):Math.random()*height,vx:vertical?0:dir==="left"?-s.velocity:s.velocity,vy:vertical?(dir==="up"?-s.velocity:s.velocity):0,at:elapsed,lifetime:s.lifetime,size:(20+Math.random()*24)*s.scale,rotation:Math.random()*Math.PI*2});
  }
  function drawText(text,x,y,size,fill,alpha=1,angle=0,scale=1,facing=1) {
    ctx.save();ctx.translate(x,y);ctx.rotate(angle);ctx.scale(scale*facing,scale);ctx.globalAlpha=Math.max(0,Math.min(1,alpha));ctx.font=Math.max(1,size)+"px system-ui, sans-serif";ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillStyle=fill;ctx.fillText(text,0,0);ctx.restore();
  }
  function paint(dt) {
    for(const t of tweens){const e=entities.get(t.id);if(!e)continue;let progress=Math.min(1,(elapsed-t.at)/t.duration);if(t.repeat)progress=Math.sin((elapsed-t.at)/t.duration*Math.PI*2);else if(t.loop)progress=Math.sin(progress*Math.PI);else if(t.easing==="easeIn")progress*=progress;else if(t.easing==="easeOut")progress=1-(1-progress)**2;else if(t.easing==="easeInOut")progress=(1-Math.cos(Math.PI*progress))/2;for(const key of t.keys)e[key]=t.from[key]+(t.values[key]-t.from[key])*progress;}
    tweens=tweens.filter(t=>(t.repeat||elapsed-t.at<t.duration)&&entities.has(t.id));effects=effects.filter(e=>elapsed-e.at<e.duration);particles=particles.filter(p=>elapsed-p.at<p.lifetime);
    ctx.clearRect(0,0,width,height);if(background!=="transparent"){ctx.fillStyle=background;ctx.fillRect(0,0,width,height);}
    ctx.save();const shake=effects.find(e=>e.kind==="shake");if(shake)ctx.translate(Math.sin(elapsed*100)*shake.magnitude,Math.cos(elapsed*97)*shake.magnitude);
    for(const s of shapes.values()){if(s.op==="label")drawText(s.text??"",(s.x??0.5)*width,(1-(s.y??0.5))*height,s.fontSize??36,color(s.color));else{ctx.strokeStyle=color(s.color);ctx.lineWidth=s.lineWidth??2;ctx.beginPath();const args=[(s.x??0.5)*width,(1-(s.y??0.5))*height,(s.width??0.1)*width,(s.height??0.1)*height];if(typeof ctx.roundRect==='function')ctx.roundRect(...args,s.cornerRadius??0);else ctx.rect(...args);ctx.stroke();}}
    for(const e of entities.values()){drawText(e.emoji,e.x*width+e.dx,(1-e.y)*height-e.dy,e.size,"white",e.alpha,e.angle,e.scale,e.facing==="left"?-1:1);if(e.tint&&e.tintAmount){ctx.save();ctx.globalAlpha=e.tintAmount*0.25;ctx.fillStyle=e.tint;ctx.beginPath();ctx.arc(e.x*width,(1-e.y)*height,e.size*e.scale*0.5,0,Math.PI*2);ctx.fill();ctx.restore();}}
    for(const e of effects){const p=(elapsed-e.at)/e.duration;if(e.kind==="shake")continue;let x=e.x*width,y=(1-e.y)*height;if(e.kind==="projectile"){x+=(e.toX-e.x)*width*p;y-=(e.toY-e.y)*height*p;drawText(e.emoji,x,y,e.size,"white",1);}else if(e.kind==="text")drawText(e.text,x,y-p*40,e.size,e.color,1-p);else drawText(e.emoji,x+e.vx*(elapsed-e.at),y+e.vy*(elapsed-e.at)+50*(elapsed-e.at)**2,e.size,"white",1-p);}
    for(const p of particles){p.x+=p.vx*dt;p.y+=p.vy*dt;drawText(p.emoji,p.x+Math.sin(elapsed*2+p.rotation)*12,p.y,p.size,"white",Math.min(1,(p.lifetime-(elapsed-p.at))*2),p.rotation+elapsed*0.2);}
    drawText(banner.text,width/2,(1-banner.y)*height,banner.fontSize,banner.color);ctx.restore();
  }
  function animate(ms) {
    if(retired)return;const now=ms/1000,dt=Math.max(0,Math.min(0.1,last?now-last:0));last=now;
    try{
      if(!paused){elapsed+=dt;effects=effects.filter(e=>elapsed-e.at<e.duration);particles=particles.filter(p=>elapsed-p.at<p.lifetime);let dispatched=0;for(const op of timeline){if(op.complete||op.at>elapsed)continue;execute(op);op.complete=true;if(++dispatched>=64)break;}
        if(cfg.mode==="particles"){emission+=dt*settings.density;const n=Math.min(32,Math.floor(emission));emission-=n;for(let i=0;i<n;i++)emitParticle();}
        if(cfg.mode==="scene"&&elapsed>=nextRound){sceneControl(sceneRound%2?"punch":"breathe-fire",{who:sceneRound%2?"kong":"godzilla"});nextRound=elapsed+3;sceneRound++;}
        paint(dt);frame++;
      }
    }catch(e){lastError={code:e.code??"provider_failed",error:String(e.message).slice(0,1024)};paused=true;}
    window.requestAnimationFrame(animate);
  }
  if(cfg.mode==="scene-script")load(JSON.parse(cfg.scene_script));else if(cfg.mode==="scene")initScene();
  Object.defineProperty(window,"__itcOverlay",{value:Object.freeze({status,control,track,shutdown:()=>{retired=true;paused=true;entities.clear();shapes.clear();effects=[];particles=[];tweens=[];timeline=[];ctx.clearRect(0,0,width,height);}}),writable:false,configurable:false});
  window.requestAnimationFrame(animate);
})();
