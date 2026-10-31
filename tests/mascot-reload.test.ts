import { expect, it, vi } from 'vitest';
import { MascotController } from '../src/content/mascot/mascot';
import type { MascotDeps } from '../src/content/mascot/mascot';

it('当前状态提示到期收起，悬停和聚焦时可重新查看，关闭气泡后隐藏', async () => {
  vi.useFakeTimers();
  const makeElement = () => {
    const classes = new Set<string>(['hidden']);
    const listeners = new Map<string, Array<() => void>>();
    const el = {
      classList: {
        add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name),
        toggle: (name: string, force?: boolean) => force ? classes.add(name) : classes.delete(name),
        contains: (name: string) => classes.has(name),
      },
      style: {}, offsetLeft: 0, offsetTop: 0, src: '', innerHTML: '', textContent: '',
      hovered: false, focused: false,
      addEventListener: (name: string, fn: () => void) => listeners.set(name, [...(listeners.get(name) ?? []), fn]),
      matches: (query: string) => query === ':hover' ? el.hovered : query === ':focus' ? el.focused : false,
      dispatch: (name: string) => { for (const fn of listeners.get(name) ?? []) fn(); },
      appendChild: vi.fn(), querySelector: () => null,
    };
    return el;
  };
  const wrap = makeElement(), mascot = makeElement(), img = makeElement(), bubble = makeElement();
  const doc = { defaultView: { innerWidth: 1440, innerHeight: 900 }, addEventListener: vi.fn(), createElement: makeElement, activeElement: null as { tagName: string } | null };
  const root = { ownerDocument: doc, getElementById: (id: string) => ({ 'mascot-wrap': wrap, mascot, 'mascot-bubble': bubble } as Record<string, unknown>)[id], querySelector: () => img };
  let enabled = true;
  try {
    const controller = new MascotController({ ui: { root }, assetUrl: (p: string) => p,
      storage: { get: async () => undefined, set: async () => {} }, onBodyClickActive: () => {}, onStartClick: () => {},
      bubblesEnabled: async () => enabled } as unknown as MascotDeps);
    controller.setSessionState('ACTIVE');
    controller.setVideoStatus('正在获取字幕…');
    await vi.advanceTimersByTimeAsync(0);
    expect(bubble.textContent).toContain('字幕');
    expect(bubble.classList.contains('hidden')).toBe(false);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(bubble.classList.contains('hidden')).toBe(true);

    doc.activeElement = { tagName: 'INPUT' };
    controller.setVideoStatus('正在下载音频…');
    await vi.advanceTimersByTimeAsync(0);
    expect(bubble.classList.contains('hidden')).toBe(true);
    controller.setBubblesEnabled(true); // 后台重连回放设置，不是用户主动查看
    await vi.advanceTimersByTimeAsync(0);
    expect(bubble.classList.contains('hidden')).toBe(true);
    doc.activeElement = null;
    await vi.advanceTimersByTimeAsync(5_001);

    mascot.hovered = true; mascot.dispatch('pointerenter');
    await vi.advanceTimersByTimeAsync(0);
    expect(bubble.textContent).toContain('音频');
    expect(bubble.classList.contains('hidden')).toBe(false);
    mascot.hovered = false; mascot.dispatch('pointerleave');
    await vi.advanceTimersByTimeAsync(301);
    expect(bubble.classList.contains('hidden')).toBe(true);

    mascot.focused = true; mascot.dispatch('focus');
    await vi.advanceTimersByTimeAsync(0);
    expect(bubble.classList.contains('hidden')).toBe(false);
    enabled = false; controller.setBubblesEnabled(false);
    expect(bubble.classList.contains('hidden')).toBe(true);
    mascot.focused = false; mascot.dispatch('blur');
    mascot.hovered = true; mascot.dispatch('pointerenter');
    await vi.advanceTimersByTimeAsync(0);
    expect(bubble.classList.contains('hidden')).toBe(true);
  } finally { vi.useRealTimers(); }
});

it('旧页面的表情定时器在扩展重载后不访问失效的 runtime', async () => {
  const callbacks = new Map<number, () => void>();
  const el = () => ({ classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn(), contains: () => false }, style: {}, addEventListener: vi.fn(), matches: () => false, offsetLeft: 0, offsetTop: 0, src: '', innerHTML: '' });
  const wrap = el(), mascot = el(), img = el(), bubble = el();
  const doc = { defaultView: { innerWidth: 1440, innerHeight: 900 }, addEventListener: vi.fn(), createElement: () => el(), activeElement: null };
  const root = { ownerDocument: doc, getElementById: (id: string) => ({'mascot-wrap': wrap, mascot, 'mascot-bubble': bubble} as Record<string, unknown>)[id], querySelector: () => img };
  let invalid = false;
  const assetUrl = vi.fn((path: string) => { if (invalid) throw new Error('Extension context invalidated.'); return `chrome-extension://fixture${path}`; });
  const controller = new MascotController({ ui: { root }, assetUrl, storage: { get: async () => undefined, set: async () => {} }, onBodyClickActive: () => {}, onStartClick: () => {}, bubblesEnabled: async () => false, setTimeout: ((cb: () => void, ms: number) => { callbacks.set(ms, cb); return ms; }) as typeof setTimeout, clearTimeout: (() => {}) as typeof clearTimeout } as unknown as MascotDeps);
  controller.pulse('happy');
  invalid = true;
  expect(() => callbacks.get(4200)!()).not.toThrow();
  expect(img.src).toBe('chrome-extension://fixture/mascot/mascot-idle.png');
  await Promise.resolve();
});

it('扩展上下文失效时气泡设置读取安静结束，其他错误保留给调用方', async () => {
  const el = () => ({ classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn(), contains: () => false }, style: {}, addEventListener: vi.fn(), matches: () => false, offsetLeft: 0, offsetTop: 0, src: '', innerHTML: '' });
  const wrap=el(), mascot=el(), img=el(), bubble=el();
  const doc={defaultView:{innerWidth:1440,innerHeight:900},addEventListener:vi.fn(),createElement:()=>el(),activeElement:null};
  const root={ownerDocument:doc,getElementById:(id:string)=>({'mascot-wrap':wrap,mascot,'mascot-bubble':bubble} as Record<string,unknown>)[id],querySelector:()=>img};
  let failure='Extension context invalidated.';
  const controller=new MascotController({ui:{root},assetUrl:(p:string)=>p,storage:{get:async()=>undefined,set:async()=>{}},onBodyClickActive:()=>{},onStartClick:()=>{},bubblesEnabled:async()=>{throw new Error(failure)},setTimeout:(()=>0) as unknown as typeof setTimeout,clearTimeout:(()=>{}) as typeof clearTimeout} as unknown as MascotDeps);
  await expect(controller.say('通知')).resolves.toBeUndefined();
  failure='其他读取错误';
  await expect(controller.say('通知')).rejects.toThrow('其他读取错误');
});

it('失效页面的位置读取和拖拽保存不会产生未处理错误，其他错误仍记录', async () => {
  const handlers = new Map<string, Function>();
  const el = (name:string) => ({ classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn(), contains: () => false }, style: {}, addEventListener: (event:string,fn:Function) => handlers.set(`${name}:${event}`,fn), matches: () => false, offsetLeft: 0, offsetTop: 0, src: '', innerHTML: '' });
  const wrap=el('wrap'), mascot=el('mascot'), img=el('img'), bubble=el('bubble');
  const doc={defaultView:{innerWidth:1440,innerHeight:900},addEventListener:(event:string,fn:Function)=>handlers.set(`doc:${event}`,fn),createElement:()=>el('new'),activeElement:null};
  const root={ownerDocument:doc,getElementById:(id:string)=>({'mascot-wrap':wrap,mascot,'mascot-bubble':bubble} as Record<string,unknown>)[id],querySelector:()=>img};
  let failure='Extension context invalidated.';
  const log=vi.spyOn(console,'error').mockImplementation(()=>{});
  try {
    new MascotController({ui:{root},assetUrl:(p:string)=>p,storage:{get:async()=>{throw new Error(failure)},set:async()=>{throw new Error(failure)}},onBodyClickActive:()=>{},onStartClick:()=>{},bubblesEnabled:async()=>false,setTimeout:(()=>0) as unknown as typeof setTimeout,clearTimeout:(()=>{}) as typeof clearTimeout} as unknown as MascotDeps);
    await new Promise(resolve=>setTimeout(resolve,0));
    const drag=()=>{handlers.get('mascot:pointerdown')!({clientX:0,clientY:0,preventDefault(){}});handlers.get('doc:pointermove')!({clientX:50,clientY:0});handlers.get('doc:pointerup')!();};
    drag(); await new Promise(resolve=>setTimeout(resolve,0));expect(log).not.toHaveBeenCalled();
    failure='存储失败'; drag();await new Promise(resolve=>setTimeout(resolve,0));
    expect(log).toHaveBeenCalledWith('[doubao] mascot storage failed',expect.objectContaining({message:'存储失败'}));
  } finally { log.mockRestore(); }
});
