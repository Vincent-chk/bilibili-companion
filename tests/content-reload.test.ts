import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  send: vi.fn(), event: undefined as ((e: any) => void) | undefined,
  opts: undefined as any, dispose: vi.fn(), toast: vi.fn(), videoStatus: vi.fn(),
  request: vi.fn(), routeMessage: undefined as ((message: any) => void) | undefined,
}));
vi.mock('wxt/browser', () => ({browser:{runtime:{sendMessage:mock.send,onMessage:{addListener:(fn:(message:any)=>void)=>{mock.routeMessage=fn;}},getURL:(x:string)=>x},storage:{local:{get:vi.fn(),set:vi.fn()}}}}));
vi.mock('../src/content/bridge',()=>({Bridge:class {constructor(cb:(e:any)=>void){mock.event=cb;} connect(){} syncState(){} request(message:unknown){return mock.request(message);}}}));
vi.mock('../src/content/mascot/mascot',()=>({MascotController:class {session='INACTIVE';setSessionState(){} setHidden(){} setState(){} setVideoStatus(value:unknown){mock.videoStatus(value);} setBubblesEnabled(){} pulse(){} say(){} reclampToViewport(){}}}));
vi.mock('../src/content/panel/panel',()=>({PanelController:class {open(){} toggle(){} handleEvent(){} followVideo(){} routeChanged(){} setLoginState(){}}}));
vi.mock('../src/content/onboarding/onboarding',()=>({openOnboarding:vi.fn()}));
vi.mock('../src/content/ui/fullscreen',()=>({setupFullscreenMigration:vi.fn()}));
vi.mock('../src/content/ui/theme',()=>({setupThemeSync:vi.fn()}));
vi.mock('../src/content/ui/root',()=>({mountDoubaoUi:()=>({host:{},root:{}}),toast:mock.toast}));
vi.mock('../src/content/watcher/dom',()=>({findVideoElement:vi.fn(),WatchSession:class {constructor(opts:any){mock.opts=opts;} dispose(){mock.dispose();mock.opts.onTick({videoKey:'BV13u411J7Zn:1'});}}}));

beforeEach(()=>{vi.resetModules();mock.event=undefined;mock.opts=undefined;mock.routeMessage=undefined;mock.send.mockReset();mock.request.mockReset().mockResolvedValue({ok:true});mock.dispose.mockReset();mock.toast.mockReset();mock.videoStatus.mockReset();vi.stubGlobal('defineContentScript',(v:unknown)=>v);vi.stubGlobal('document',{addEventListener:vi.fn(),visibilityState:'visible'});vi.stubGlobal('window',{addEventListener:vi.fn()});vi.stubGlobal('location',{href:'https://www.bilibili.com/video/BV13u411J7Zn'});vi.stubGlobal('history',{pushState:vi.fn(),replaceState:vi.fn()});});
afterEach(()=>vi.unstubAllGlobals());
async function start(){
 mock.send.mockResolvedValue({ok:true,videoKey:'BV13u411J7Zn:1',duration:60,triggerSeconds:10});
 const entry=await import('../entrypoints/content');entry.default.main({} as never);
 mock.event!({type:'SESSION_STATE',state:'ACTIVE'});mock.event!({type:'WATCH_SETTINGS',paused:false});
 await vi.waitFor(()=>expect(mock.opts).toBeDefined());mock.send.mockClear();
}
it('首次解析当前视频不会清除并重复显示相同的等待状态',async()=>{
 let resolveVideo!: (value: unknown) => void;
 mock.send.mockImplementation(() => new Promise(resolve => { resolveVideo = resolve; }));
 const entry=await import('../entrypoints/content');entry.default.main({} as never);
 mock.event!({type:'SESSION_STATE',state:'ACTIVE'});mock.event!({type:'WATCH_SETTINGS',paused:false});
 await vi.waitFor(()=>expect(resolveVideo).toBeDefined());
 mock.videoStatus.mockClear();
 resolveVideo({ok:true,videoKey:'BV13u411J7Zn:1',duration:60,triggerSeconds:10});
 await vi.waitFor(()=>expect(mock.opts).toBeDefined());
 expect(mock.videoStatus).not.toHaveBeenCalledWith(null);
});
it('暂停期间切换分 P 时丢弃旧分 P 迟到的只读状态',async()=>{
 const pending: Array<{ page: number; resolve: (value: unknown) => void }> = [];
 mock.request.mockImplementation((message: { type: string; page: number }) => message.type === 'CURRENT_VIDEO_STATUS'
   ? new Promise(resolve => pending.push({page:message.page,resolve})) : Promise.resolve({ok:true}));
 const entry=await import('../entrypoints/content');entry.default.main({} as never);
 mock.event!({type:'SESSION_STATE',state:'ACTIVE'});mock.event!({type:'WATCH_SETTINGS',paused:true});
 await vi.waitFor(()=>expect(pending.some(item=>item.page===1)).toBe(true));
 const url='https://www.bilibili.com/video/BV13u411J7Zn?p=2';
 (location as unknown as {href:string}).href=url;
 mock.routeMessage!({type:'ROUTE_CHANGED',url});
 await vi.waitFor(()=>expect(pending.some(item=>item.page===2)).toBe(true));
 pending.filter(item=>item.page===2).at(-1)!.resolve({ok:true,videoKey:'BV13u411J7Zn:2',summary:{status:'done',source:'ai_sub'}});
 await vi.waitFor(()=>expect(mock.videoStatus).toHaveBeenLastCalledWith('陪看已暂停，本视频摘要已完成'));
 for(const item of pending.filter(item=>item.page===1)) item.resolve({ok:true,videoKey:'BV13u411J7Zn:1',lastJob:{type:'REGENERATE',status:'failed'}});
 await Promise.resolve(); await Promise.resolve();
 expect(mock.videoStatus).toHaveBeenLastCalledWith('陪看已暂停，本视频摘要已完成');
});
for(const method of ['onTick','onTrigger'] as const) it(`${method} 扩展失效时停止上报且不泄漏同步异常`,async()=>{
 await start();mock.send.mockImplementation(()=>{throw new Error('Extension context invalidated.');});
 expect(()=>mock.opts[method]({videoKey:'BV13u411J7Zn:1'})).not.toThrow();
 expect(mock.dispose).toHaveBeenCalledOnce();expect(mock.send).toHaveBeenCalledOnce();
 mock.opts.onTick({});mock.opts.onTrigger({});expect(mock.send).toHaveBeenCalledOnce();
});
it('收到扩展失效通知后先阻止最终 tick 再停止 watcher',async()=>{
 await start();mock.event!({type:'EXTENSION_RELOAD_REQUIRED'});
 expect(mock.dispose).toHaveBeenCalledOnce();expect(mock.send).not.toHaveBeenCalled();
 mock.opts.onTick({});mock.opts.onTrigger({});expect(mock.send).not.toHaveBeenCalled();
 mock.event!({type:'WATCH_SETTINGS',paused:false,restartWatcher:true});
 expect(mock.send).not.toHaveBeenCalled();
});
it('同步普通错误不被伪装为扩展失效',async()=>{
 await start();mock.send.mockImplementation(()=>{throw new Error('other error');});
 expect(()=>mock.opts.onTick({})).toThrow('other error');expect(mock.dispose).not.toHaveBeenCalled();
});
it('异步拒绝报告扩展失效后停止后续上报',async()=>{
 await start();mock.send.mockRejectedValue(new Error('Extension context invalidated.'));
 mock.opts.onTick({});await vi.waitFor(()=>expect(mock.dispose).toHaveBeenCalledOnce());
 expect(mock.send).toHaveBeenCalledOnce();mock.opts.onTrigger({});expect(mock.send).toHaveBeenCalledOnce();
});
