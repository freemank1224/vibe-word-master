/* Planet Sprint · hand-painted Canvas 2D pseudo-3D renderer. No assets or timers. */
import type { OrbitAction, OrbitObstacle } from '../services/wordOrbit';

export interface WordOrbitRenderState { time: number; running: boolean; reducedMotion: boolean; progress: number; obstacle: OrbitObstacle; action: { type: OrbitAction; elapsed: number } | null; combo: number; zone: number }
export interface WordOrbitRenderer { render: (state: WordOrbitRenderState) => void; destroy: () => void }
type Paint = string | CanvasGradient | CanvasPattern;
  const TAU = Math.PI * 2;
  const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
  const ease = (n: number) => { n = clamp(n, 0, 1); return n * n * (3 - 2 * n); };
  const palettes = [
    {sky:'#161b42', sky2:'#494775', horizon:'#a18baf', sand:'#fff0c9', sand2:'#d6b390', road:'#eec99f', edge:'#bf9d86', crystal:'#8de7d2', crystalDark:'#438d94'},
    {sky:'#302046', sky2:'#79546e', horizon:'#e1b09f', sand:'#ffe2bc', sand2:'#dc9a83', road:'#edb896', edge:'#b5807d', crystal:'#efb2a4', crystalDark:'#b97987'},
    {sky:'#172743', sky2:'#3c6379', horizon:'#b0d5d6', sand:'#ebf7ef', sand2:'#a1c7d2', road:'#d7e8e5', edge:'#8eafb7', crystal:'#b3eceb', crystalDark:'#73a6bf'}
  ];
  let seed = 9128;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const stars = Array.from({length:62}, () => ({x:rand()*900-82, y:rand()*184, r:.45+rand()*1.2, a:.22+rand()*.55, phase:rand()*6.28}));
  const scenery = Array.from({length:30}, (_, i) => ({phase:rand(), side:i%2?-1:1, lane:1.12+rand()*1.75, kind:i%4, size:.72+rand()*.48, twist:rand()*2-1, hue:i%3}));
  const dustSeeds = Array.from({length:16}, (_, i) => ({a: i / 16 * TAU + rand()*.3, s:.5+rand()*.5, r:1.4+rand()*2.8}));
  function rounded(ctx: CanvasRenderingContext2D,x: number,y: number,w: number,h: number,r: number) {
    r=Math.min(r,w/2,h/2); ctx.beginPath(); ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r);ctx.lineTo(x+w,y+h-r);ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);ctx.lineTo(x+r,y+h);ctx.quadraticCurveTo(x,y+h,x,y+h-r);ctx.lineTo(x,y+r);ctx.quadraticCurveTo(x,y,x+r,y);ctx.closePath();
  }
  function poly(ctx: CanvasRenderingContext2D, pts: number[], fill: Paint, stroke?: Paint, width?: number) {
    ctx.beginPath();ctx.moveTo(pts[0],pts[1]);for(let i=2;i<pts.length;i+=2)ctx.lineTo(pts[i],pts[i+1]);ctx.closePath();if(fill){ctx.fillStyle=fill;ctx.fill();}if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=width||1;ctx.stroke();}
  }
  function ellipse(ctx: CanvasRenderingContext2D,x: number,y: number,rx: number,ry: number,fill: Paint) {ctx.beginPath();ctx.ellipse(x,y,rx,ry,0,0,TAU);ctx.fillStyle=fill;ctx.fill();}
  function line(ctx: CanvasRenderingContext2D,pts: number[],color: Paint,width: number) {ctx.beginPath();ctx.moveTo(pts[0],pts[1]);for(let i=2;i<pts.length;i+=2)ctx.lineTo(pts[i],pts[i+1]);ctx.strokeStyle=color;ctx.lineWidth=width;ctx.lineCap='round';ctx.lineJoin='round';ctx.stroke();}
  function bezier(ctx: CanvasRenderingContext2D,p: number[],color: Paint,width: number) {ctx.beginPath();ctx.moveTo(p[0],p[1]);ctx.bezierCurveTo(p[2],p[3],p[4],p[5],p[6],p[7]);ctx.strokeStyle=color;ctx.lineWidth=width;ctx.lineCap='round';ctx.stroke();}
  function project(z: number, lane: number) {
    const p=Math.pow(Math.max(0,z),1.72);
    return {x:368+Math.sin((1-z)*2.3)*37+(lane||0)*(9+151*p),y:169+265*p,s:.07+1.33*p,half:9+151*p};
  }
export function createWordOrbitRenderer(canvas: HTMLCanvasElement): WordOrbitRenderer {
    const ctx=canvas.getContext('2d',{alpha:false});
    if (!ctx) return { render() {}, destroy() {} };
    let activeReducedMotion = false;
    let dead=false, lastTime: number | null=null, worldTime=0, cssW=0,cssH=0,dpr=1;
    let visibleLeft=0,visibleRight=736,colors=palettes[0],bgGradient: CanvasGradient,soilGradient: CanvasGradient;
    let lastZone=-1;
    function resize(zone: number) {
      const rect=canvas.getBoundingClientRect();
      const w=Math.max(1,rect.width||canvas.clientWidth||736),h=Math.max(1,rect.height||canvas.clientHeight||420);
      const nextDpr=Math.min(window.devicePixelRatio||1,2);
      const didResize=w!==cssW||h!==cssH||dpr!==nextDpr;
      if(didResize){cssW=w;cssH=h;dpr=nextDpr;canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);}
      const scale=cssH/420;
      ctx.setTransform(dpr*scale,0,0,dpr*scale,dpr*(cssW-736*scale)/2,0);
      visibleLeft=368-cssW/scale/2;visibleRight=736-visibleLeft;
      if(lastZone!==zone||!bgGradient||didResize) {
        colors=palettes[zone]||palettes[0];lastZone=zone;
        bgGradient=ctx.createLinearGradient(0,0,0,310);bgGradient.addColorStop(0,colors.sky);bgGradient.addColorStop(.62,colors.sky2);bgGradient.addColorStop(1,colors.horizon);
        soilGradient=ctx.createLinearGradient(0,168,0,450);soilGradient.addColorStop(0,colors.sand);soilGradient.addColorStop(.34,colors.sand);soilGradient.addColorStop(1,colors.sand2);
      }
    }
    function sky(t: number) {
      ctx.fillStyle=bgGradient;ctx.fillRect(visibleLeft-4,0,visibleRight-visibleLeft+8,420);
      const nebula=ctx.createRadialGradient(410,125,5,410,125,210);nebula.addColorStop(0,'rgba(219,144,197,.14)');nebula.addColorStop(1,'rgba(219,144,197,0)');ctx.fillStyle=nebula;ctx.fillRect(visibleLeft,0,visibleRight-visibleLeft,240);
      for(let i=0;i<stars.length;i++) {const s=stars[i];ctx.globalAlpha=s.a*(.85+.15*Math.sin(t*.65+s.phase));ellipse(ctx,s.x,s.y,s.r,s.r,'#fff5e0');if(i%13===0){line(ctx,[s.x-3,s.y,s.x+3,s.y],'#fff2d3',.6);line(ctx,[s.x,s.y-3,s.x,s.y+3],'#fff2d3',.6);}}
      ctx.globalAlpha=1;
      if(lastZone===2) {
        // Translucent curtains, like reflected silk in a polar atmosphere.
        ctx.save();
        for(let band=0;band<3;band++) {
          const drift=Math.sin(t*.18+band)*9;
          const aurora=ctx.createLinearGradient(0,15,0,154);aurora.addColorStop(0,'rgba(122,230,195,0)');aurora.addColorStop(.38,band===1?'rgba(187,169,241,.17)':'rgba(126,236,203,.18)');aurora.addColorStop(1,'rgba(138,228,219,0)');
          ctx.beginPath();ctx.moveTo(visibleLeft-30,45+band*16);ctx.bezierCurveTo(260,148+drift,390,-18+band*12,visibleRight+30,74+band*20);ctx.lineTo(visibleRight+30,129+band*17);ctx.bezierCurveTo(392,37+band*12,260,208+drift,visibleLeft-30,108+band*16);ctx.closePath();ctx.fillStyle=aurora;ctx.fill();
        }
        ctx.restore();
      }
      // A ringed pearl planet, repositioned into the narrow mobile sky.
      const planetX=Math.min(588,visibleRight-59),planetY=76;
      ctx.save();ctx.translate(planetX,planetY);ctx.rotate(-.28);
      ctx.strokeStyle='rgba(248,210,185,.15)';ctx.lineWidth=13;ctx.beginPath();ctx.ellipse(0,0,78,21,0,0,TAU);ctx.stroke();
      ctx.strokeStyle='#cba5b9';ctx.lineWidth=5;ctx.beginPath();ctx.ellipse(0,0,74,18,0,0,TAU);ctx.stroke();
      const planetGrad=ctx.createRadialGradient(-14,-17,4,0,0,43);planetGrad.addColorStop(0,'#ffe7c8');planetGrad.addColorStop(.58,'#ddb8b5');planetGrad.addColorStop(1,'#8e7baf');ellipse(ctx,0,0,41,41,planetGrad);
      ctx.save();ctx.beginPath();ctx.arc(0,0,40.8,0,TAU);ctx.clip();
      for(let i=0;i<4;i++){ctx.strokeStyle=i%2?'rgba(132,109,160,.19)':'rgba(255,236,217,.18)';ctx.lineWidth=8;ctx.beginPath();ctx.ellipse(-5,-31+i*19,57,12,.1,0,Math.PI);ctx.stroke();}ctx.restore();
      ctx.strokeStyle='#f5d4c2';ctx.lineWidth=5;ctx.beginPath();ctx.ellipse(0,0,74,18,0,0,Math.PI);ctx.stroke();
      ctx.strokeStyle='rgba(255,237,208,.57)';ctx.lineWidth=1.4;ctx.beginPath();ctx.ellipse(0,2,80,21,0,.03,Math.PI-.06);ctx.stroke();ctx.restore();
      const moonX=Math.max(113,visibleLeft+44);
      const moon=ctx.createRadialGradient(moonX-5,72,2,moonX,78,18);moon.addColorStop(0,'#a9c8d7');moon.addColorStop(1,'#66839d');ellipse(ctx,moonX,78,17,17,moon);ellipse(ctx,moonX+5,73,3.5,3,'rgba(64,91,127,.25)');ellipse(ctx,moonX-5,83,2.8,2,'rgba(64,91,127,.2)');
      // Thin luminous clouds make the globe's atmosphere feel deep.
      cloud(214+Math.sin(t*.05)*9,146,.8,'rgba(229,220,238,.11)');cloud(485+Math.cos(t*.04)*8,159,1.15,'rgba(250,225,226,.13)');cloud(70,195,.88,'rgba(218,205,235,.12)');
    }
    function cloud(x: number,y: number,s: number,fill: Paint){ctx.save();ctx.translate(x,y);ctx.scale(s,s);ctx.fillStyle=fill;ctx.beginPath();ctx.moveTo(-57,5);ctx.bezierCurveTo(-49,-7,-25,-7,-19,-6);ctx.bezierCurveTo(-15,-23,14,-21,21,-6);ctx.bezierCurveTo(41,-12,66,0,60,6);ctx.closePath();ctx.fill();ctx.restore();}
    function terrain(t: number) {
      // Elliptical horizon: a visibly small world, with a bright atmosphere rim.
      ctx.beginPath();ctx.moveTo(-120,345);ctx.bezierCurveTo(11,218,171,161,368,165);ctx.bezierCurveTo(565,161,725,218,856,345);ctx.lineTo(856,440);ctx.lineTo(-120,440);ctx.closePath();ctx.fillStyle=soilGradient;ctx.fill();
      ctx.beginPath();ctx.moveTo(-80,307);ctx.bezierCurveTo(62,202,185,161,368,165);ctx.bezierCurveTo(551,161,674,202,816,307);ctx.strokeStyle='rgba(255,246,215,.7)';ctx.lineWidth=3;ctx.stroke();
      // Each world has its own silhouette as well as a distinct palette.
      if(lastZone===1) {
        poly(ctx,[175,195,187,157,201,153,201,139,227,139,237,151,247,151,257,180,274,184],'#c69292');
        poly(ctx,[201,153,201,139,227,139,237,151,247,151,257,180,224,177],'#e8b2a0');
        poly(ctx,[466,180,477,154,480,133,511,133,513,156,528,168,538,195],'#b98590');
        poly(ctx,[480,133,511,133,513,156,504,177,478,180],'#dfa693');
        line(ctx,[192,163,232,163],'rgba(255,220,177,.45)',2);line(ctx,[481,146,510,146],'rgba(255,222,184,.4)',2);
      } else if(lastZone===2) {
        poly(ctx,[216,184,230,164,241,131,251,159,269,179],'#b4d8dc');poly(ctx,[241,131,251,159,269,179,243,170],'#83b2c5');
        poly(ctx,[455,180,475,147,483,152,493,119,510,160,531,187],'#c6e5e5');poly(ctx,[493,119,510,160,531,187,491,170],'#96bfce');
        poly(ctx,[133,204,153,174,162,190,177,197],'#cfdfdf');poly(ctx,[542,196,557,160,571,192],'#b6d6db');
      } else {
        poly(ctx,[226,181,235,158,244,164,251,153,264,176,281,182],'#a7c9bc');poly(ctx,[245,177,251,153,264,176],'#78a9a4');
        poly(ctx,[460,177,470,154,480,160,486,142,498,169,519,183],'#c0b4c3');poly(ctx,[481,171,486,142,498,169,504,178],'#989bad');
        poly(ctx,[139,201,151,181,165,184,178,193,188,199],'#ceccb4');poly(ctx,[540,195,551,173,563,179,570,194],'#9ebbb1');
      }
      // Broad curved sand terraces on either side.
      bezier(ctx,[15,314,89,264,203,249,282,251],'rgba(170,134,113,.10)',3);
      bezier(ctx,[527,262,616,266,691,300,745,350],'rgba(170,134,113,.14)',4);
      bezier(ctx,[-15,365,93,307,159,308,236,314],'rgba(255,248,219,.35)',7);
      ribbon(1.20,'rgba(159,127,113,.15)');ribbon(1.10,'#f8e0b9');ribbon(1.0,colors.edge);ribbon(.965,colors.road);
      // Receding irregular pavers and mint side lights imply speed without a 3D engine.
      for(let i=0;i<14;i++) {
        const z=((i/14+t*.115)%1.06);if(z<.02)continue;
        const p=project(z,0), q=project(z+.014,0);
        const bend=2+5*z;
        ctx.strokeStyle='rgba(156,118,102,'+(.1+.15*z)+')';ctx.lineWidth=.6+z*1.4;
        ctx.beginPath();ctx.moveTo(p.x-p.half*.95,p.y);ctx.quadraticCurveTo(p.x,p.y+bend,p.x+p.half*.95,p.y);ctx.stroke();
        for(let side=-1;side<=1;side+=2) {
          const a=project(z,side*1.045),b=project(z+.024,side*1.045);
          line(ctx,[a.x,a.y,b.x,b.y],'rgba(107,174,164,.68)',1+z*3);
          line(ctx,[a.x-side*1.1,a.y-1,b.x-side*1.1,b.y-1],'rgba(238,255,224,.72)',.7+z*1.3);
        }
        if(i%2===0){const stripe=project(z,-.03);ellipse(ctx,stripe.x,stripe.y,Math.max(1.3,z*2.4),.55+z*.65,'rgba(255,240,205,.56)');}
      }
      // Small colored mineral chips remain in the sand, never obscuring the word area.
      for(let i=0;i<19;i++) {const z=(i*.113+t*.11)%1;const side=i%2?-1:1;const p=project(z,side*(1.2+(i%5)*.35));ellipse(ctx,p.x,p.y,(1+z*3),(1+z)*.7,i%3?'rgba(154,129,117,.24)':'rgba(108,167,153,.34)');}
    }
    function ribbon(mult: number,fill: Paint) {
      ctx.beginPath();let p=project(0,-mult);ctx.moveTo(p.x,p.y);
      for(let i=1;i<=24;i++){p=project(i/22,-mult);ctx.lineTo(p.x,p.y);}
      for(let i=24;i>=0;i--){p=project(i/22,mult);ctx.lineTo(p.x,p.y);}ctx.closePath();ctx.fillStyle=fill;ctx.fill();
    }
    function crystal(x: number,y: number,s: number,twist: number,hue: number) {
      ctx.save();ctx.translate(x,y);ctx.scale(s,s);ctx.rotate(twist*.09);ellipse(ctx,1,1,21,5,'rgba(98,89,108,.16)');
      const a=hue===1?'#f4b6a7':hue===2?'#b4a5e0':colors.crystal;
      const b=hue===1?'#cd857f':hue===2?'#7c78b5':colors.crystalDark;
      poly(ctx,[-17,0,-22,-23,-12,-37,-4,-18,-4,2],a);poly(ctx,[-12,-37,-4,-18,-4,2,-11,-5],b);
      poly(ctx,[-6,2,-12,-39,0,-65,13,-39,12,-2],a,'rgba(255,250,231,.4)',1);
      poly(ctx,[0,-65,3,-28,12,-2,13,-39],b);poly(ctx,[0,-65,-12,-39,-6,-7,3,-28],'rgba(255,255,226,.25)');
      poly(ctx,[9,0,11,-24,23,-39,28,-18,20,4],a);poly(ctx,[23,-39,20,-16,20,4,28,-18],b);
      line(ctx,[-6,-37,-2,-47],'rgba(255,255,234,.7)',2);line(ctx,[15,-23,19,-29],'rgba(255,255,234,.6)',1.4);ctx.restore();
    }
    function rock(x: number,y: number,s: number,twist: number) {
      ctx.save();ctx.translate(x,y);ctx.scale(s,s);ctx.rotate(twist*.1);ellipse(ctx,0,1,29,7,'rgba(100,83,91,.15)');
      poly(ctx,[-27,-1,-29,-12,-15,-29,8,-33,28,-17,25,2,5,8],'#c3a990');
      poly(ctx,[-29,-12,-15,-29,8,-33,12,-18,-7,-10],'#edcfaa');poly(ctx,[12,-18,8,-33,28,-17,25,2,5,8],'#aa8e81');poly(ctx,[-27,-1,-29,-12,-7,-10,5,8],'#d9b899');
      line(ctx,[-19,-15,-12,-21,-3,-20],'rgba(255,239,206,.65)',1.5);ellipse(ctx,-13,1,6,2,'#a4b6a0');ctx.restore();
    }
    function plant(x: number,y: number,s: number,twist: number) {
      ctx.save();ctx.translate(x,y);ctx.scale(s,s);ellipse(ctx,0,1,14,3,'rgba(99,91,93,.14)');
      bezier(ctx,[0,1,-2,-15,7,-24,4,-39],'#628f83',4);bezier(ctx,[2,-13,-10,-15,-14,-24,-15,-29],'#628f83',3);bezier(ctx,[4,-25,17,-26,17,-34,18,-37],'#628f83',2.4);
      ellipse(ctx,4,-39,8,10,'#e19b91');ellipse(ctx,2,-42,4,5,'#f7c3a6');ellipse(ctx,-15,-29,5,7,'#8cc9b1');ellipse(ctx,18,-37,6,8,'#b3a4d5');
      poly(ctx,[-2,-6,-13,-15,-18,-8,-7,-4],'#a3c6a6');poly(ctx,[1,-12,12,-20,18,-15,7,-10],'#76ab95');ctx.restore();
    }
    function littleMushroom(x: number,y: number,s: number) {ctx.save();ctx.translate(x,y);ctx.scale(s,s);ellipse(ctx,0,2,17,4,'rgba(97,75,87,.13)');line(ctx,[0,0,1,-19],'#dbc2a4',7);ctx.beginPath();ctx.moveTo(-22,-17);ctx.bezierCurveTo(-17,-41,15,-43,23,-16);ctx.quadraticCurveTo(1,-7,-22,-17);ctx.fillStyle='#bd8fa8';ctx.fill();ctx.beginPath();ctx.moveTo(-22,-17);ctx.quadraticCurveTo(0,-23,23,-16);ctx.quadraticCurveTo(0,-6,-22,-17);ctx.fillStyle='#816b91';ctx.fill();ellipse(ctx,-7,-25,4,2,'#f3d1ba');ellipse(ctx,8,-29,3,2,'#edc9ba');ctx.restore();}
    function drawScenery(t: number,foreground: boolean) {
      // Depth sorting keeps nearby props in front of distant ones.
      for(let pass=0;pass<11;pass++)for(let i=0;i<scenery.length;i++) {
        const o=scenery[i];const z=(o.phase+t*.11)%1.10;
        if(z<.045||z>=1.05||Math.floor(z*10)!==pass)continue;
        const p=project(z,o.side*o.lane);if((p.y>355)!==foreground)continue;
        const s=p.s*o.size;
        if(o.kind===0)crystal(p.x,p.y,s,o.twist,o.hue);else if(o.kind===1)rock(p.x,p.y,s,o.twist);else if(o.kind===2)plant(p.x,p.y,s,o.twist);else littleMushroom(p.x,p.y,s*.8);
      }
    }
    function obstacle(kind: OrbitObstacle,z: number,t: number) {
      const p=project(z,0),s=p.s;
      if(p.y>570||z<.04)return;
      ctx.save();ctx.translate(p.x,p.y);ctx.scale(s,s);
      if(kind==='gap') {
        ellipse(ctx,1,8,90,22,'rgba(114,85,104,.25)');
        poly(ctx,[-84,-4,-62,-14,-40,-11,-17,-17,9,-15,29,-20,49,-12,71,-13,87,-2,82,20,62,22,49,29,19,23,1,30,-24,23,-43,27,-65,16,-80,15],'#6d597b');
        poly(ctx,[-79,0,-60,-6,-43,-5,-17,-11,9,-9,29,-13,49,-6,71,-7,80,1,73,14,48,19,18,17,0,22,-25,17,-44,20,-66,11],'#292c4e');
        bezier(ctx,[-65,5,-24,23,31,-3,67,5],'rgba(150,137,213,.55)',2);
        poly(ctx,[-84,-4,-62,-14,-40,-11,-17,-17,-20,-9,-42,-4,-63,-8,-78,2],colors.sand);
        poly(ctx,[80,18,62,22,49,29,19,23,1,30,-24,23,-43,27,-65,16,-62,11,-42,20,-24,16,0,22,18,17,48,20,62,16], '#c49d89');
        for(let i=0;i<5;i++){const px=-56+i*27,py=3+Math.sin(t*1.6+i*2)*4;ellipse(ctx,px,py,1,1,'#c2b4f1');}
      } else if(kind==='arch') {
        ellipse(ctx,7,4,67,11,'rgba(92,84,110,.19)');
        poly(ctx,[-56,0,-56,-48,-42,-67,-12,-76,20,-71,53,-49,60,-8,51,2,42,-42,26,-53,-25,-55,-40,-41,-41,1],'#437e89');
        ctx.beginPath();ctx.moveTo(-60,0);ctx.lineTo(-60,-43);ctx.quadraticCurveTo(-56,-77,-9,-78);ctx.quadraticCurveTo(44,-80,53,-47);ctx.lineTo(54,0);ctx.lineTo(32,0);ctx.lineTo(32,-37);ctx.quadraticCurveTo(28,-52,-7,-53);ctx.quadraticCurveTo(-36,-52,-39,-35);ctx.lineTo(-39,0);ctx.closePath();
        const ag=ctx.createLinearGradient(0,-78,0,0);ag.addColorStop(0,'#c6edcb');ag.addColorStop(.4,colors.crystal);ag.addColorStop(1,'#79b5ac');ctx.fillStyle=ag;ctx.fill();ctx.strokeStyle='rgba(250,255,223,.65)';ctx.lineWidth=1.4;ctx.stroke();
        poly(ctx,[32,-37,40,-42,42,0,32,0],'#4b9296');poly(ctx,[-60,-43,-51,-43,-51,0,-60,0],'rgba(246,255,220,.19)');
        line(ctx,[-55,-31,-46,-31],'#edf8ce',3);line(ctx,[-55,-22,-46,-22],'#e5f0ca',3);line(ctx,[37,-29,46,-29],'#d6edbb',3);
        ellipse(ctx,-7,-67,8,7,'#5e8f9b');poly(ctx,[-7,-73,-2,-67,-7,-61,-12,-67],'#fff0bc');
        line(ctx,[-30,-63,-21,-66],'rgba(255,255,232,.8)',2);line(ctx,[13,-63,23,-58],'rgba(255,255,232,.7)',2);
        // A short low gate reads as a clear sliding challenge.
        line(ctx,[-36,-34,30,-34],'rgba(254,241,180,.74)',3);
      } else {
        ellipse(ctx,5,5,58,11,'rgba(105,80,88,.18)');
        poly(ctx,[-50,-1,-52,-27,-35,-45,-2,-51,28,-45,46,-31,53,-4,22,8,-16,9],'#bd8e7f');
        poly(ctx,[-52,-27,-35,-45,-2,-51,28,-45,46,-31,17,-23,-9,-27,-29,-20],'#f1be98');
        poly(ctx,[-52,-27,-29,-20,-16,9,-50,-1],'#d5a087');poly(ctx,[17,-23,46,-31,53,-4,22,8],'#a47b7b');
        poly(ctx,[-29,-20,-9,-27,17,-23,22,8,-16,9],'#dfaa88');
        line(ctx,[-34,-31,-22,-36,-8,-36],'#ffdfad',2);line(ctx,[-15,-15,-6,-8,-8,3],'#b17e76',2);
        poly(ctx,[4,-49,8,-68,17,-74,23,-58,20,-45],'#a5e4cc');poly(ctx,[17,-74,16,-55,20,-45,23,-58],'#5baca8');
        ellipse(ctx,-39,-5,5,3,'#eac49a');ellipse(ctx,36,-13,4,2,'rgba(247,210,169,.5)');
      }
      // A floating gold marker gently tells the eye where the next action lives.
      if(z<.72){const fy=(kind==='arch'?-94:kind==='gap'?-34:-85)+Math.sin(t*2)*3;ctx.save();ctx.translate(0,fy);ctx.rotate(Math.PI/4);rounded(ctx,-5,-5,10,10,2);ctx.fillStyle='#fff2be';ctx.fill();ctx.strokeStyle='rgba(255,244,208,.33)';ctx.lineWidth=4;ctx.stroke();ctx.restore();}
      ctx.restore();
    }
    function particleBurst(e: number,x: number,y: number,color: Paint,force: number) {
      if(activeReducedMotion||e<0||e>.42)return;const f=e/.42;ctx.globalAlpha=(1-f)*.7;
      for(let i=0;i<dustSeeds.length;i++){const d=dustSeeds[i];const dx=Math.cos(d.a)*(8+f*force)*d.s,dy=Math.sin(d.a)*(4+f*force*.26)*d.s-f*(1-f)*26;ellipse(ctx,x+dx,y+dy,d.r*(1+f*.5),d.r*.55,color);}ctx.globalAlpha=1;
      ctx.strokeStyle='rgba(255,244,203,'+((1-f)*.5)+')';ctx.lineWidth=2.4*(1-f);ctx.beginPath();ctx.ellipse(x,y,12+f*force,3+f*force*.22,0,0,TAU);ctx.stroke();
    }
    function avatar(t: number,state: WordOrbitRenderState) {
      const action=state.action,kind: OrbitAction | null=action ? action.type : null,e=action?Math.max(0,action.elapsed):0;
      const running=state.running,reduce=state.reducedMotion;
      const phase=running?t*13:0;
      let jump=0,squash=1,rot=0,shift=0,spread=0;
      if(kind==='jump'){jump=86*Math.sin(Math.PI*clamp(e/.66,0,1));spread=Math.sin(Math.PI*clamp(e/.66,0,1));if(e>.66)squash=1-.17*Math.sin(Math.PI*clamp((e-.66)/.20,0,1));}
      if(kind==='jet'){jump=88*Math.sin(Math.PI*clamp(e/.80,0,1));spread=.7*Math.sin(Math.PI*clamp(e/.8,0,1));if(e>.8)squash=1-.16*Math.sin(Math.PI*clamp((e-.8)/.2,0,1));}
      if(kind==='slide'){const envelope=Math.sin(Math.PI*clamp(e/.85,0,1));squash=1-.48*Math.pow(envelope,.45);rot=-.12*envelope;shift=9*envelope;}
      if(kind==='fall'){const n=clamp(e/.75,0,1);rot=TAU*ease((n-.04)/.77);shift=-20*Math.sin(n*Math.PI);jump=13*Math.sin(n*Math.PI)*Math.abs(Math.sin(n*TAU));squash=1-.18*Math.sin(n*Math.PI);}
      if(reduce){jump*=.18;rot*=.06;shift*=.2;squash=Math.max(.9,squash);}
      const baseY=355,bob=kind?0:(running?Math.abs(Math.sin(phase)) * 3:Math.sin(t*1.8)*.65);
      const x=368+shift,y=baseY-jump-bob;
      const shadowW=30-jump*.1;
      ellipse(ctx,368,baseY+1,shadowW,6-jump*.025,'rgba(105,85,108,'+(.22-jump*.001)+')');ellipse(ctx,368,baseY+1,shadowW*.55,3.4,'rgba(76,69,94,'+(.16-jump*.001)+')');
      // Streaks are behind the explorer. They grow only after a three-word combo.
      if(state.combo>=3&&running&&!reduce){ctx.save();ctx.globalAlpha=.42;for(let i=0;i<3;i++){const tail=Math.sin(t*8+i)*4;bezier(ctx,[x-15+i*15,y-31,x-32+i*13,y-5,x-43+i*13,y+17+tail,x-61+i*12,y+32+tail],i===1?'#ffe8ac':'#98e7d1',3-i*.7);}ctx.restore();}
      if(kind==='jet'&&e<.8){const jetForce=Math.sin(Math.PI*clamp(e/.8,0,1));for(let side=-1;side<=1;side+=2){ctx.save();ctx.translate(x+side*12,y-16);const flame=18+jetForce*29+Math.sin(t*40)*5;ctx.beginPath();ctx.moveTo(-5,0);ctx.quadraticCurveTo(-12,flame*.48,0,flame);ctx.quadraticCurveTo(11,flame*.45,5,0);ctx.closePath();ctx.fillStyle='#ffa96f';ctx.fill();ctx.beginPath();ctx.moveTo(-3,0);ctx.quadraticCurveTo(-6,flame*.35,0,flame*.68);ctx.quadraticCurveTo(6,flame*.3,3,0);ctx.fillStyle='#fff4bf';ctx.fill();ctx.restore();}particleBurst(e% .22,x,baseY,'#f8dfb6',58);}
      if(kind==='slide')particleBurst(e%.4,x-13,baseY,'#f9e1bb',45);
      if(kind==='fall'){particleBurst(e-.04,x,baseY,'#e8ccac',65);particleBurst(e-.28,x-12,baseY,'#f8e4c4',50);}
      if(kind==='jump')particleBurst(e-.66,x,baseY,'#fff1cb',68);
      if(kind==='jet')particleBurst(e-.8,x,baseY,'#fff2ce',76);
      ctx.save();ctx.translate(x,y);ctx.translate(0,-42);ctx.rotate(rot);ctx.scale(1+(1-squash)*.19,squash);ctx.translate(0,42);
      // Two scarf tails arc away from the direction of travel.
      const flap=Math.sin(t*9)*4;
      ctx.beginPath();ctx.moveTo(-10,-65);ctx.bezierCurveTo(-26,-66,-31,-56+flap,-49,-64+flap);ctx.lineTo(-43,-54+flap);ctx.bezierCurveTo(-28,-49,-20,-58,-9,-58);ctx.closePath();ctx.fillStyle='#ed8e78';ctx.fill();
      ctx.beginPath();ctx.moveTo(-8,-61);ctx.bezierCurveTo(-26,-59,-26,-48+flap,-39,-50+flap);ctx.lineTo(-34,-42+flap);ctx.bezierCurveTo(-23,-44,-22,-54,-8,-55);ctx.closePath();ctx.fillStyle='#c96f74';ctx.fill();
      // Far legs and arms first, with bevelled suit joints.
      const stride=kind?0:Math.sin(phase),arm=kind?0:Math.sin(phase+.5);
      limb(-8,-26,-11,-13-4*stride,-10-stride*3,-4-Math.max(0,stride)*7,spread, -1,kind);
      limb(9,-26,12,-13+4*stride,11-stride*3,-4-Math.max(0,-stride)*7,spread, 1,kind);
      const armLift=spread*14;
      armShape(-18,-49,-24-armLift*.35,-34-arm*4-armLift,-25-armLift*.65,-24-arm*7-armLift,-1);
      armShape(18,-49,24+armLift*.35,-34+arm*4-armLift,25+armLift*.65,-24+arm*7-armLift,1);
      const body=ctx.createLinearGradient(-22,-50,20,-18);body.addColorStop(0,'#f9eddb');body.addColorStop(.62,'#f1dfc6');body.addColorStop(1,'#c3b8b1');
      rounded(ctx,-20,-58,40,39,14);ctx.fillStyle='#859da5';ctx.fill();rounded(ctx,-19,-58,38,35,13);ctx.fillStyle=body;ctx.fill();
      line(ctx,[-17,-24,17,-24],'#839a9d',4);
      // Rear harness and twin oxygen tanks: the silhouette clearly faces away.
      bezier(ctx,[-15,-57,-21,-46,-22,-31,-15,-23],'#577e8a',4);
      bezier(ctx,[15,-57,21,-46,22,-31,15,-23],'#577e8a',4);
      rounded(ctx,-17,-58,34,36,9);ctx.fillStyle='#527587';ctx.fill();
      rounded(ctx,-10,-57,20,34,5);ctx.fillStyle='#799d9f';ctx.fill();
      rounded(ctx,-6,-54,12,28,3);ctx.fillStyle='#aec8b9';ctx.fill();
      line(ctx,[0,-50,0,-35],'#7c9f98',1);ellipse(ctx,0,-30,2,2,'#d4aa88');
      // The twin cylinders stand proud of the rear panel and end in dark nozzles.
      for(let side=-1;side<=1;side+=2) {
        const bx=side*12;
        const tank=ctx.createLinearGradient(bx-6,0,bx+6,0);tank.addColorStop(0,'#6e9d9f');tank.addColorStop(.35,'#daebe0');tank.addColorStop(.72,'#a8cfc5');tank.addColorStop(1,'#5c909a');
        rounded(ctx,bx-6,-59,12,39,6);ctx.fillStyle=tank;ctx.fill();
        ellipse(ctx,bx,-56,5,2.4,'#d7e7d6');
        rounded(ctx,bx-6,-48,12,4,1);ctx.fillStyle='#638b91';ctx.fill();
        rounded(ctx,bx-6,-30,12,4,1);ctx.fillStyle='#638b91';ctx.fill();
        rounded(ctx,bx-5,-23,10,8,2);ctx.fillStyle='#516e80';ctx.fill();
        ellipse(ctx,bx,-16,5,2.8,'#324c64');ellipse(ctx,bx,-16,2.6,1.4,kind==='jet'?'#fff2bf':'#80b3bc');
        line(ctx,[bx-2,-54,bx-2,-50],'rgba(255,255,235,.8)',1.4);
      }
      rounded(ctx,-5,-44,10,10,3);ctx.fillStyle='#d58e79';ctx.fill();line(ctx,[-2,-39,2,-39],'#ffdfac',1.4);
      // Neck scarf, helmet shadow, then the domed, reflective back of the helmet.
      ellipse(ctx,0,-61,20,6,'#d47b73');ellipse(ctx,1,-62,18,4,'#f1a18b');ellipse(ctx,2,-65,19,6,'rgba(61,79,104,.3)');
      const helmet=ctx.createRadialGradient(-9,-86,2,2,-75,28);helmet.addColorStop(0,'#fff9e8');helmet.addColorStop(.56,'#f3e8d5');helmet.addColorStop(.86,'#c9d7d2');helmet.addColorStop(1,'#7497a5');ellipse(ctx,0,-79,25,25,helmet);
      // Visible right visor edge suggests volume, without drawing a face on the back.
      ctx.beginPath();ctx.moveTo(18,-97);ctx.bezierCurveTo(33,-84,27,-67,15,-61);ctx.bezierCurveTo(23,-74,24,-84,18,-97);ctx.fillStyle='#4b728c';ctx.fill();
      ctx.beginPath();ctx.moveTo(20,-91);ctx.bezierCurveTo(26,-82,24,-73,20,-69);ctx.strokeStyle='#9adbd6';ctx.lineWidth=2.2;ctx.stroke();
      ellipse(ctx,-22,-78,5,9,'#90b2b6');ellipse(ctx,-23,-78,3,6,'#c2e0d5');ellipse(ctx,23,-78,3,7,'#617f94');
      ctx.beginPath();ctx.arc(-3,-80,17,3.72,4.82);ctx.strokeStyle='rgba(255,255,244,.95)';ctx.lineWidth=4;ctx.lineCap='round';ctx.stroke();
      // A vertical rear-shell stripe and panel seams cannot be mistaken for a face.
      ctx.save();ctx.beginPath();ctx.ellipse(0,-79,24.5,24.5,0,0,TAU);ctx.clip();
      ctx.beginPath();ctx.moveTo(-5,-105);ctx.bezierCurveTo(-2,-91,-3,-74,-5,-53);ctx.lineTo(2,-53);ctx.bezierCurveTo(5,-74,5,-91,2,-105);ctx.closePath();ctx.fillStyle='rgba(139,174,177,.6)';ctx.fill();
      bezier(ctx,[-18,-94,-21,-82,-18,-67,-12,-61],'rgba(123,153,160,.42)',.8);
      bezier(ctx,[12,-98,17,-86,16,-74,11,-61],'rgba(123,153,160,.37)',.8);
      ctx.restore();ellipse(ctx,-14,-65,1.4,1.4,'#a0b8b6');ellipse(ctx,11,-65,1.4,1.4,'#93acb0');
      // Stubby antenna and a coral navigation light.
      line(ctx,[-14,-98,-17,-109],'#95abae',2);ellipse(ctx,-17,-109,3.4,3.4,'#efa78e');ellipse(ctx,-18,-110,1.2,1.2,'#ffe9c6');
      ctx.restore();
      if(kind==='fall'&&e>.12&&e<.6){const a=(e-.12)/.48;ctx.globalAlpha=Math.sin(a*Math.PI);for(let i=0;i<3;i++){const angle=t*7+i*TAU/3;const px=x+Math.cos(angle)*28,py=y-104+Math.sin(angle)*7;drawStar(px,py,3.4,'#ffe5a3');}ctx.globalAlpha=1;}
      if((kind==='jump'||kind==='jet')&&e<.38){ctx.globalAlpha=(1-e/.38)*.55;drawStar(x+31,y-68,4.5,'#fff4c3');drawStar(x-32,y-43,3.2,'#b9f4d7');ctx.globalAlpha=1;}
    }
    function limb(hx: number,hy: number,kx: number,ky: number,fx: number,fy: number,spread: number,side: number,kind: OrbitAction | null) {
      if(kind==='jump'){ky-=spread*9;fy-=spread*14;fx+=side*spread*7;}
      if(kind==='slide'){fx+=side===1?18:-7;fy-=4;kx+=side===1?8:-7;}
      bezier(ctx,[hx,hy,kx,ky,kx,ky,fx,fy],'#91a3a8',12);bezier(ctx,[hx-1,hy,kx-1,ky,kx-1,ky,fx-1,fy-1],'#ede4d2',9);
      ctx.save();ctx.translate(fx,fy);ctx.rotate(side*.08);rounded(ctx,-8,-5,16,9,4);ctx.fillStyle='#456477';ctx.fill();rounded(ctx,-8,1,16,4,2);ctx.fillStyle='#a8d7c2';ctx.fill();line(ctx,[-4,-4,3,-4],'#b8c4bc',1.2);ctx.restore();
    }
    function armShape(hx: number,hy: number,ex: number,ey: number,fx: number,fy: number,side: number) {
      bezier(ctx,[hx,hy,ex,ey,ex,ey,fx,fy],'#849da6',11);bezier(ctx,[hx,hy,ex-side,ey,ex-side,ey,fx-side,fy-1],'#f5e6cc',8.5);ellipse(ctx,fx,fy,5.5,6,'#cc8e81');ellipse(ctx,fx-side,fy-2,3.5,3.5,'#eeaf94');
    }
    function drawStar(x: number,y: number,r: number,color: Paint) {ctx.beginPath();for(let i=0;i<8;i++){const a=i*Math.PI/4,rr=i%2?r*.34:r;const px=x+Math.cos(a)*rr,py=y+Math.sin(a)*rr;i?ctx.lineTo(px,py):ctx.moveTo(px,py);}ctx.closePath();ctx.fillStyle=color;ctx.fill();}
    function speedlines(t: number,state: WordOrbitRenderState) {
      if(state.reducedMotion||!state.running||(!state.action&&state.combo<3))return;
      const alpha=state.action&&state.action.type==='jet'?.26:.11;
      ctx.globalAlpha=alpha;
      for(let i=0;i<8;i++){const side=i%2?-1:1;const z=(i*.147+t*.8)%1;const p=project(.25+z*.7,side*(1.55+i%3*.3));const q=project(.29+z*.7,side*(1.55+i%3*.3));line(ctx,[p.x,p.y,q.x,q.y],'#fff3d5',.8+z*1.3);}ctx.globalAlpha=1;
    }
    function render(state: WordOrbitRenderState) {
      if(dead||!ctx)return;
      activeReducedMotion=state.reducedMotion;const zone=clamp(Math.floor(state.zone||0),0,2),now=Number.isFinite(state.time)?state.time:0;
      if(lastTime===null){lastTime=now;}else {if(now<lastTime)worldTime=0;else if(state.running)worldTime+=Math.min(.1,now-lastTime);lastTime=now;}
      resize(zone);
      const t=state.reducedMotion ? 0 : worldTime;
      const a=state.action;
      let shakeX=0,shakeY=0;
      if(a&&!state.reducedMotion) {
        if(a.type==='fall'&&a.elapsed<.34){const amp=5.5*(1-a.elapsed/.34);shakeX=Math.sin(a.elapsed*91)*amp;shakeY=Math.cos(a.elapsed*74)*amp*.45;}
        else if((a.type==='jump'||a.type==='jet')){const landing=a.type==='jet'?.8:.66,d=a.elapsed-landing;if(d>=0&&d<.12)shakeY=Math.sin(d*70)*2*(1-d/.12);}
      }
      ctx.save();ctx.translate(shakeX,shakeY);
      sky(t);terrain(t);drawScenery(t,false);
      let z=.12+clamp(state.progress==null?.52:state.progress,0,1)*.6;
      if(a)z=.72+Math.max(0,a.elapsed)*1.02;
      const kind=state.obstacle||'rock';
      const obstacleY=project(z,0).y;
      if(obstacleY<=359)obstacle(kind,z,t);
      speedlines(t,state);avatar(t,state);
      if(obstacleY>359)obstacle(kind,z,t);
      drawScenery(t,true);
      ctx.restore();
      // Fine vignette gathers focus around the road, without a dark HUD overlay.
      const vig=ctx.createRadialGradient(368,220,150,368,220,430);vig.addColorStop(0,'rgba(18,23,49,0)');vig.addColorStop(1,'rgba(18,23,49,.18)');ctx.fillStyle=vig;ctx.fillRect(visibleLeft,0,visibleRight-visibleLeft,420);
      if(a&&a.type==='fall'&&a.elapsed<.16&&!state.reducedMotion){ctx.fillStyle='rgba(247,148,116,'+(.055*(1-a.elapsed/.16))+')';ctx.fillRect(visibleLeft,0,visibleRight-visibleLeft,420);}
    }
    return {render, destroy(){dead=true;}};
}
