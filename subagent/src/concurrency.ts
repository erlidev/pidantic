interface Waiter {
	limit: number;
	resolve(release: () => void): void;
	reject(error: Error): void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

/** FIFO semaphore whose limit is captured from configuration for each incoming spawn call. */
export class ConcurrencyGate {
	active = 0;
	private readonly waiting: Waiter[] = [];

	async acquire(limit: number, signal?: AbortSignal): Promise<() => void> {
		if (signal?.aborted) throw new Error("Subagent spawn aborted while waiting for a concurrency slot.");
		if (this.waiting.length === 0 && this.active < limit) return this.reserve();

		return new Promise<() => void>((resolve, reject) => {
			const waiter: Waiter = { limit, resolve, reject, ...(signal ? { signal } : {}) };
			if (signal) {
				waiter.onAbort = () => {
					const index = this.waiting.indexOf(waiter);
					if (index < 0) return;
					this.waiting.splice(index, 1);
					reject(new Error("Subagent spawn aborted while waiting for a concurrency slot."));
					this.drain();
				};
				signal.addEventListener("abort", waiter.onAbort, { once: true });
			}
			this.waiting.push(waiter);
			this.drain();
		});
	}

	private reserve(): () => void {
		this.active += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active = Math.max(0, this.active - 1);
			this.drain();
		};
	}

	private drain(): void {
		while (this.waiting.length > 0) {
			const waiter = this.waiting[0] as Waiter;
			if (this.active >= waiter.limit) return;
			this.waiting.shift();
			if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
			waiter.resolve(this.reserve());
		}
	}
}
