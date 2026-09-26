// tests/audio/webaudioMock.ts — a minimal, strict Web Audio stand-in for driving the WP13 runtime under Node.
// Nothing is rendered: nodes record their connections, AudioParams record automation and THROW on non-finite
// values (as the real API does), buffer sources track start/stop. The clock is advanced by the test.

export class MockClock { t = 0 }

export class MockParam {
  value: number;
  events = 0;
  private readonly name: string;
  constructor(v: number, name: string) { this.value = v; this.name = name; }
  private chk(v: number, t: number): void {
    if (!Number.isFinite(v) || !Number.isFinite(t)) throw new TypeError(`non-finite AudioParam value on ${this.name}: ${v} @ ${t}`);
    this.events++;
  }
  setValueAtTime(v: number, t: number): this { this.chk(v, t); this.value = v; return this; }
  linearRampToValueAtTime(v: number, t: number): this { this.chk(v, t); this.value = v; return this; }
  exponentialRampToValueAtTime(v: number, t: number): this {
    this.chk(v, t);
    if (v === 0) throw new RangeError('exponential ramp to 0');
    this.value = v;
    return this;
  }
  setTargetAtTime(v: number, t: number, tau: number): this { this.chk(v, t); this.chk(tau, 0); this.value = v; return this; }
  cancelScheduledValues(t: number): this { this.chk(0, t); return this; }
}

export class MockNode {
  readonly outs = new Set<MockNode>();
  connected = 0;
  readonly ctx: MockContext;
  readonly type: string;
  constructor(ctx: MockContext, type: string) { this.ctx = ctx; this.type = type; ctx.nodes++; }
  connect<T extends MockNode>(d: T): T { this.outs.add(d); d.connected++; return d; }
  disconnect(): void { for (const o of this.outs) o.connected--; this.outs.clear(); }
}

export class MockBuffer {
  readonly data: Float32Array[];
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels; this.length = length; this.sampleRate = sampleRate;
    this.data = [];
    for (let c = 0; c < numberOfChannels; c++) this.data.push(new Float32Array(length));
  }
  get duration(): number { return this.length / this.sampleRate; }
  copyToChannel(src: Float32Array, c: number): void { this.data[c].set(src.subarray(0, this.length)); }
  getChannelData(c: number): Float32Array { return this.data[c]; }
}

export class MockSource extends MockNode {
  buffer: MockBuffer | null = null;
  loop = false;
  readonly playbackRate: MockParam;
  onended: (() => void) | null = null;
  started = -1;
  stopped = -1;
  constructor(ctx: MockContext) { super(ctx, 'source'); this.playbackRate = new MockParam(1, 'playbackRate'); ctx.sources.add(this); }
  start(when = 0, offset = 0): void {
    if (this.started >= 0) throw new Error('InvalidStateError: start twice');
    if (!Number.isFinite(when) || !Number.isFinite(offset) || when < 0 || offset < 0) throw new RangeError(`bad start ${when} ${offset}`);
    if (!this.buffer) throw new Error('start without buffer');
    this.started = when;
    this.ctx.starts++;
  }
  stop(when = 0): void {
    if (this.started < 0) throw new Error('InvalidStateError: stop before start');
    if (!Number.isFinite(when)) throw new RangeError('bad stop');
    this.stopped = when;
  }
  /** called by MockContext.advance */
  tick(now: number): void {
    if (this.started < 0 || !this.buffer) return;
    const end = this.stopped >= 0 ? this.stopped : this.loop ? Infinity : this.started + this.buffer.duration / Math.max(1e-3, this.playbackRate.value);
    if (now >= end) {
      this.ctx.sources.delete(this);
      this.started = -2;
      this.onended?.();
    }
  }
  get playing(): boolean { return this.started >= 0 && this.ctx.currentTime >= this.started; }
}

function params<T extends object>(o: T, names: Record<string, number>): T {
  for (const [k, v] of Object.entries(names)) (o as Record<string, unknown>)[k] = new MockParam(v, k);
  return o;
}

export class MockContext {
  static clock = new MockClock();
  static last: MockContext | null = null;
  static meterAmp = 0.1;
  readonly sampleRate: number;
  state = 'suspended';
  onstatechange: (() => void) | null = null;
  readonly destination: MockNode;
  readonly listener: Record<string, MockParam>;
  readonly baseLatency = 0.005;
  readonly outputLatency = 0.02;
  nodes = 0;
  starts = 0;
  buffers = 0;
  readonly sources = new Set<MockSource>();

  constructor(o?: { sampleRate?: number }) {
    this.sampleRate = o?.sampleRate ?? 48000;
    this.destination = new MockNode(this, 'destination');
    this.listener = params({}, { positionX: 0, positionY: 0, positionZ: 0, forwardX: 0, forwardY: 0, forwardZ: -1, upX: 0, upY: 1, upZ: 0 }) as Record<string, MockParam>;
    MockContext.last = this;
  }
  get currentTime(): number { return MockContext.clock.t; }
  resume(): Promise<void> { this.state = 'running'; this.onstatechange?.(); return Promise.resolve(); }
  close(): Promise<void> { this.state = 'closed'; return Promise.resolve(); }
  advance(dt: number): void {
    MockContext.clock.t += dt;
    for (const s of [...this.sources]) s.tick(MockContext.clock.t);
  }

  createGain(): MockNode { return params(new MockNode(this, 'gain'), { gain: 1 }); }
  createBiquadFilter(): MockNode {
    return Object.assign(params(new MockNode(this, 'biquad'), { frequency: 350, Q: 1, gain: 0 }), { type: 'lowpass' });
  }
  createDelay(max = 1): MockNode { return Object.assign(params(new MockNode(this, 'delay'), { delayTime: 0 }), { maxDelayTime: max }); }
  createConvolver(): MockNode { return Object.assign(new MockNode(this, 'convolver'), { buffer: null, normalize: true }); }
  createDynamicsCompressor(): MockNode {
    return params(new MockNode(this, 'compressor'), { threshold: -24, ratio: 12, knee: 30, attack: 0.003, release: 0.25 });
  }
  createPanner(): MockNode {
    return Object.assign(params(new MockNode(this, 'panner'), { positionX: 0, positionY: 0, positionZ: 0, orientationX: 1, orientationY: 0, orientationZ: 0 }),
      { panningModel: 'equalpower', distanceModel: 'inverse', refDistance: 1, rolloffFactor: 1, maxDistance: 10000 });
  }
  /** analyser: the "output" it reports is a 440 Hz sine of amplitude MockContext.meterAmp (NaN to simulate a fault) */
  createAnalyser(): MockNode {
    return Object.assign(new MockNode(this, 'analyser'), {
      fftSize: 2048,
      getFloatTimeDomainData: (b: Float32Array): void => {
        for (let i = 0; i < b.length; i++) b[i] = MockContext.meterAmp * Math.sin((2 * Math.PI * 440 * i) / this.sampleRate);
      },
    });
  }
  createStereoPanner(): MockNode { return params(new MockNode(this, 'stereoPanner'), { pan: 0 }); }
  createBufferSource(): MockSource { return new MockSource(this); }
  createBuffer(ch: number, len: number, sr: number): MockBuffer { this.buffers++; return new MockBuffer(ch, len, sr); }
}

/** Install the mock as globalThis.AudioContext for the duration of a test file. */
export function installWebAudioMock(): () => void {
  const g = globalThis as Record<string, unknown>;
  const prev = g.AudioContext;
  g.AudioContext = MockContext;
  MockContext.clock.t = 0;
  return () => { g.AudioContext = prev; };
}
