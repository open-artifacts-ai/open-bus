/**
 * jsdom has no EventSource. This fake records instances and lets a test push
 * frames or fail the connection. Installed by the tests that need it and
 * removed again in `afterEach`.
 */
export class FakeEventSource {
  static all: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.all.push(this);
  }
  close() {
    this.closed = true;
  }
  /** Server-side frame. */
  push(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  /** A raw `data:` payload, valid JSON or not. */
  pushRaw(data: unknown) {
    this.onmessage?.({ data });
  }
  fail() {
    this.onerror?.({});
  }
}

export const installFakeEventSource = () => {
  FakeEventSource.all = [];
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  return () => {
    delete (globalThis as { EventSource?: unknown }).EventSource;
  };
};

export const lastSource = () => {
  const s = FakeEventSource.all.at(-1);
  if (!s) throw new Error("no EventSource was opened");
  return s;
};
