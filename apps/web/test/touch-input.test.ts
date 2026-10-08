import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Input } from '../src/input.js';
import { prefersTouch, stickAxes, stickSprint, touchLookDelta, TouchControls } from '../src/touch-controls.js';

// Native EventTargets exercise the actual input listeners without a renderer.
let input: Input;
let canvas: HTMLCanvasElement;
beforeEach(() => {
  vi.stubGlobal('window', Object.assign(new EventTarget(), { matchMedia: () => ({ matches: true }) }));
  vi.stubGlobal('document', Object.assign(new EventTarget(), { pointerLockElement: null }));
  vi.stubGlobal('navigator', { maxTouchPoints: 5 });
  canvas = Object.assign(new EventTarget(), { requestPointerLock: vi.fn() }) as unknown as HTMLCanvasElement;
  input = new Input({ canvas, touch: true });
});
afterEach(() => { input.dispose(); vi.unstubAllGlobals(); });

describe('phone input', () => {
  it('runs only at full forward deflection on foot, never in the crane', () => {
    expect(stickSprint('foot', 1)).toBe(true);
    expect(stickSprint('foot', 0.8)).toBe(false);
    expect(stickSprint('foot', -1)).toBe(false);
    expect(stickSprint('crane', 1)).toBe(false);
    expect(stickSprint('blade', 1)).toBe(false);
  });
  it('uses the same modest sensitivity for aiming and tool-button dragging', () => {
    expect(touchLookDelta(100, -50)).toEqual({ yaw: -0.3, pitch: 0.15 });
  });
  it('aims with the action finger without releasing fire or the walking finger', () => {
    input.requestLock();
    input.setTouchMove(1, 0);
    input.setTouchKey('Mouse0', true);
    // Exercise actual gesture handlers; the element only needs capture cleanup.
    const element = { classList: { remove: vi.fn() }, hasPointerCapture: () => false };
    const pointer = { element, kind: 'key', code: 'Mouse0', x: 100, y: 100 };
    const controls = Object.assign(Object.create(TouchControls.prototype), {
      input, pointers: new Map([[5, pointer]]),
    }) as { move(e: PointerEvent): void; end(id: number): void };
    controls.move({ pointerId: 5, clientX: 120, clientY: 90, preventDefault() {} } as PointerEvent);
    expect(input.state.firing).toBe(true);
    expect(input.consumeLook()).toEqual({ yaw: -0.06, pitch: 0.03 });
    controls.end(99);
    expect(input.state.firing).toBe(true);
    controls.end(5);
    expect(input.state.firing).toBe(false);
    expect(input.sample().forward).toBe(1);
  });
  it('starts and pauses without Pointer Lock support', () => {
    expect(input.active).toBe(false);
    input.requestLock();
    expect(input.active).toBe(true);
    expect(canvas.requestPointerLock).not.toHaveBeenCalled();
    input.releaseLock();
    expect(input.active).toBe(false);
  });
  it('recognises touch devices while keeping desktops on keyboard/mouse', () => {
    expect(prefersTouch()).toBe(true);
    vi.stubGlobal('navigator', { maxTouchPoints: 0 });
    expect(prefersTouch()).toBe(false);
  });
  it('allows movement, camera and continuous tool use at the same time', () => {
    input.requestLock();
    input.setTouchMove(0.8, -0.4);
    input.setTouchKey('Mouse0', true);
    input.state.dYaw = 0.3;
    expect(input.sample()).toMatchObject({ forward: 0.8, right: -0.4, firing: true });
    expect(input.consumeLook().yaw).toBe(0.3);
    expect(input.consumeLook().yaw).toBe(0);
    expect(input.take('Mouse0')).toBe(true);
    expect(input.take('Mouse0')).toBe(false);
    input.setTouchKey('Mouse0', false);
    expect(input.sample().firing).toBe(false);
    expect(input.sample().forward).toBe(0.8);
  });
  it('supports crane hoist and vehicle blade/brake using the same held controls', () => {
    input.requestLock();
    input.setTouchKey('Space', true);
    input.setTouchKey('ControlLeft', true);
    expect(input.sample()).toMatchObject({ jump: true, crouch: true });
    input.setTouchKey('Space', false);
    expect(input.sample()).toMatchObject({ jump: false, crouch: true });
  });
  it('clears throttle, fire, pending taps and camera on blur/pause', () => {
    input.requestLock();
    input.setTouchMove(1, 1);
    input.setTouchKey('Mouse0', true);
    input.setTouchKey('Space', true);
    input.state.dPitch = 0.6;
    input.state.wheel = 1;
    window.dispatchEvent(new Event('blur'));
    expect(input.sample()).toMatchObject({ forward: 0, right: 0, firing: false, jump: false, wheel: 0, dPitch: 0 });
    expect(input.take('Mouse0')).toBe(false);
    input.releaseLock();
    input.setTouchKey('Mouse0', true);
    expect(input.state.firing).toBe(false);
    input.requestLock();
    expect(input.sample().forward).toBe(0);
  });
  it('uses a dead zone, proportional throttle and capped diagonals', () => {
    expect(stickAxes(2, 2, 50)).toEqual({ forward: -0, right: 0 });
    expect(stickAxes(0, -50, 50)).toEqual({ forward: 1, right: 0 });
    expect(stickAxes(0, -25, 50).forward).toBeCloseTo(0.431818);
    const diagonal = stickAxes(100, -100, 50);
    expect(Math.hypot(diagonal.forward, diagonal.right)).toBeCloseTo(1);
    expect(stickAxes(0, 0, 0)).toEqual({ forward: 0, right: 0 });
  });
  it('preserves desktop pointer lock and keyboard movement', () => {
    const desktop = new Input({ canvas });
    desktop.requestLock();
    expect(canvas.requestPointerLock).toHaveBeenCalledOnce();
    window.dispatchEvent(Object.assign(new Event('keydown'), { code: 'KeyW', repeat: false }));
    expect(desktop.sample().forward).toBe(1);
    window.dispatchEvent(Object.assign(new Event('keyup'), { code: 'KeyW' }));
    expect(desktop.sample().forward).toBe(0);
    desktop.dispose();
  });
});
