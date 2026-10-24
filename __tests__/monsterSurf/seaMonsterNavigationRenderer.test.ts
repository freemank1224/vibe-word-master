import test from 'node:test';
import assert from 'node:assert/strict';
import { startSurf } from '../../features/monster-surf/game.ts';
import { createSeaMonsterRenderer, seaChaseCameraOffset } from '../../features/monster-surf/seaMonsterRenderer.ts';
import { SURF_ISLAND_ART } from '../../features/monster-surf/islandArt.ts';
import type { SurfObstacle, SurfState } from '../../features/monster-surf/types.ts';

const context = {} as CanvasRenderingContext2D;
const ORIGIN = 1600;
const clamp = (n: number, low=0, high=1) => Math.max(low, Math.min(high, n));
const smooth = (n: number) => { const t=clamp(n); return t*t*(3-2*t); };
const island = (id: number, variant: number, x: number, ahead: number, hit=false): SurfObstacle => ({
  id, variant, x, y: ORIGIN+ahead, rx:SURF_ISLAND_ART[variant].collisionRx,
  ry:SURF_ISLAND_ART[variant].collisionRy, hit,
});
const scenarios = [
  { name:'large island', speed:90, x:(t:number)=>740+18*Math.sin(t*.45),
    obstacles:[island(1,6,560,180),island(2,0,54,40),island(3,1,952,400),island(4,4,565,800)] },
  { name:'coastal archipelago', speed:90, x:(t:number)=>510+35*Math.sin(t*.48),
    obstacles:[island(10,5,260,170),island(11,3,735,390),island(12,6,290,680),island(13,0,62,30),island(14,1,944,220),island(15,2,42,440),island(16,0,958,770),island(17,7,720,1080)] },
  { name:'near-shore target', speed:80, x:(t:number)=>670-495*smooth((t-1)/4),
    obstacles:[island(20,0,45,470),island(21,1,55,700),island(22,0,42,960),island(23,6,780,190),island(24,4,655,650)] },
  { name:'previously hit island', speed:90, x:(t:number)=>745+15*Math.sin(t*.38),
    obstacles:[island(30,7,570,180,true),island(31,0,53,10),island(32,2,970,450),island(33,5,565,820,true)] },
];
type Point = {x:number;y:number};
/** Independent continuous sweep, deliberately not using the navigator's clearance helper. */
function sweptClearance(from: Point, to: Point, obstacles: SurfObstacle[], rx:number, ry:number): number {
  let minimum=Infinity;
  for(const obstacle of obstacles){
    const sx=obstacle.rx+rx,sy=obstacle.ry+ry;
    const px=(from.x-obstacle.x)/sx,py=(from.y-obstacle.y)/sy;
    const dx=(to.x-from.x)/sx,dy=(to.y-from.y)/sy;
    const distance=dx*dx+dy*dy;
    const along=distance?clamp(-(px*dx+py*dy)/distance):0;
    minimum=Math.min(minimum,Math.hypot(px+dx*along,py+dy*along)-1);
  }
  return minimum;
}
function view(state: SurfState,width=1318,height=596) {
  return {width,height,heroX:state.x*width/1000,heroY:height*.57+seaChaseCameraOffset(height,state.chase)};
}
for(const scenario of scenarios){
  test(`real renderer follower sweeps safely around ${scenario.name} on all desktop sizes`,()=>{
    for(const [width,height] of [[1318,596],[1392,728],[1872,908]]){
      const renderer=createSeaMonsterRenderer(context);
      let previous:Point|undefined; let detours=0; let minimum=Infinity;
      let previousFootprint={rx:0,ry:0};
      for(let elapsed=0,index=0;elapsed<=14000;elapsed+=index%73===0?120:16,index++){
        const t=elapsed/1000;
        const state:SurfState={...startSurf(),phase:'surfing',correct:10,elapsedMs:5000+elapsed,
          x:scenario.x(t),distance:ORIGIN+scenario.speed*t,speed:scenario.speed,obstacles:scenario.obstacles,
          chase:{...startSurf().chase,phase:'chasing',phaseMs:3000+elapsed}};
        const frame=renderer.prepare(state,view(state,width,height),false);
        assert.ok(frame);
        assert.ok(Number.isFinite(frame.worldX)&&Number.isFinite(frame.worldY));
        const position={x:frame.worldX,y:frame.worldY};
        const rx=Math.max(previousFootprint.rx,frame.footprintRx),ry=Math.max(previousFootprint.ry,frame.footprintRy);
        const clearance=sweptClearance(previous||position,position,scenario.obstacles,rx,ry);
        minimum=Math.min(minimum,clearance);
        assert.ok(clearance>=-1e-7,`${scenario.name} ${width}px at ${elapsed}ms: body crossed coast by normalized ${clearance}`);
        assert.ok(frame.worldX>=frame.footprintRx&&frame.worldX<=1000-frame.footprintRx,'body remains within the water world');
        if(frame.navigation==='detour')detours++;
        previous=position;previousFootprint={rx:frame.footprintRx,ry:frame.footprintRy};
      }
      assert.ok(detours>0,`${scenario.name} ${width}px must exercise an actual detour, not an empty-water path`);
      assert.ok(minimum<1,`${scenario.name} must approach an island closely enough to test avoidance`);
    }
  });
}

test('renderer pause and desktop resize preserve a safe physical follower position',()=>{
  const renderer=createSeaMonsterRenderer(context);
  const scenario=scenarios[0];
  const initial=startSurf();
  let state:SurfState={...initial,phase:'surfing',correct:10,elapsedMs:5000,x:740,distance:ORIGIN,
    speed:90,obstacles:scenario.obstacles,chase:{...initial.chase,phase:'chasing',phaseMs:3000}};
  for(let step=0;step<180;step++){
    state={...state,elapsedMs:state.elapsedMs+16,distance:state.distance+1.44};
    renderer.prepare(state,view(state),false);
  }
  const paused:SurfState={...state,phase:'paused',resumePhase:'surfing'};
  const before=renderer.prepare(paused,view(paused),false)!;
  const after=renderer.prepare(paused,view(paused),false)!;
  assert.deepEqual(after,before,'paused clocks do not move the world actor');
  for(const [width,height] of [[1392,728],[1872,908],[1318,596]]){
    const frame=renderer.prepare(paused,view(paused,width,height),false)!;
    const clearance=sweptClearance({x:frame.worldX,y:frame.worldY},{x:frame.worldX,y:frame.worldY},scenario.obstacles,frame.footprintRx,frame.footprintRy);
    assert.ok(clearance>=-1e-7,JSON.stringify({width,height,clearance,x:frame.worldX,y:frame.worldY,rx:frame.footprintRx,ry:frame.footprintRy,navigation:frame.navigation}));
  }
});

test('warning, approach, attack and retreat keep the entire actor outside the same solid island',()=>{
  const obstacles=[island(41,6,560,180,true),island(42,0,30,230)];
  const stages=['warning','approach','attacking','retreating'] as const;
  for(const reduced of [false,true])for(const stage of stages){
    const renderer=createSeaMonsterRenderer(context);
    let previous:Point|undefined;
    const initial=startSurf();
    for(let elapsed=0;elapsed<=1760;elapsed+=16){
      const state:SurfState={...initial,phase:stage==='attacking'?'sinking':'surfing',correct:10,
        elapsedMs:6000+elapsed,phaseMs:elapsed,x:740,distance:ORIGIN+215,speed:200,obstacles,
        chase:{...initial.chase,phase:stage==='approach'?'chasing':stage,phaseMs:elapsed,
          mistakes:stage==='attacking'?3:stage==='approach'?2:0,
          action:stage==='approach'?'close':'follow',actionMs:Math.min(700,elapsed)}};
      const frame=renderer.prepare(state,view(state),reduced)!;
      const point={x:frame.worldX,y:frame.worldY};
      const clearance=sweptClearance(previous||point,point,obstacles,frame.footprintRx,frame.footprintRy);
      assert.ok(clearance>=-1e-7,`${stage}, reduced=${reduced}, t=${elapsed}: ${clearance}`);
      previous=point;
    }
  }
});
