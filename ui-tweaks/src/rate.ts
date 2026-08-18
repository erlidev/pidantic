/**
 * Generation rate — the tokens per second the footer shows.
 *
 * Only the provider knows the real token count, and it reports it once, when the message is done.
 * That is enough for an exact rate per finished message, but a number that appears after the
 * generation it describes is not a live indicator, so the rate shown while a message streams is
 * estimated from the characters that have arrived, divided by a chars-per-token ratio.
 *
 * The ratio is not guessed twice: every finished message reports both its exact token count and the
 * characters it produced, so the estimate is calibrated against what this model actually emits and
 * converges within a message or two. Thinking that a provider hides still counts toward `output`,
 * which pushes the ratio down — that is the correct direction, since those tokens were generated
 * and paid for even though no character of them arrived.
 *
 * Tool results never enter any of this. Only an assistant message's own deltas are counted — its
 * reply text, its thinking, and its tool-call arguments, all of which the provider bills as output
 * — and the exact rate uses the provider's `output` count, which is the model's own tokens and
 * nothing a tool printed.
 *
 * ## The window
 *
 * The live number is a trailing three seconds, not the message so far: an average over a long reply
 * stops moving halfway through it, where a short window still reads as speed — it responds when the
 * model speeds up or stalls, which is the only reason to watch a live rate at all.
 *
 * A window has to begin somewhere, and it never begins at the request: prompt processing is not
 * generation, and counting it would make a large context read as a slow model. It begins three
 * seconds ago, or at the first streamed fragment while a message is younger than that.
 *
 * Whatever opens the window is then excluded from the count. Tokens that arrived *at* the window's
 * start were generated before it, so counting them while timing from that instant hands them over
 * for free — which is exactly what made a short tool-call message claim several hundred tokens a
 * second, its one big first chunk divided by the sliver of time after it.
 *
 * ## Arrival is not generation
 *
 * A fragment is not evidence that its tokens were produced at the instant it landed; it is evidence
 * that they were produced since the fragment before it. So each one is spread over that interval and
 * the window counts the part of it that falls inside — which is the same number as counting whole
 * fragments while output flows in small pieces, and the only correct one when it does not.
 *
 * Not every backend streams every part of a message. A server that generates a tool call in a
 * separate constrained pass — TabbyAPI does — sends nothing at all while it writes the arguments and
 * then delivers them in one chunk, and a proxy that buffers behaves the same way in miniature. With
 * arrival-time counting, a file being written reads as a model that slowed to a stop and then, for
 * one frame, as several thousand tokens a second. Spread over the interval it was generated in, the
 * same chunk reads as the throughput it actually represents.
 *
 * For the same reason the window ends at the newest fragment rather than at the current frame: while
 * nothing is arriving, there is no new measurement, so the last one stands instead of being divided
 * by a growing stretch of silence. A genuinely stalled provider therefore shows the rate it was last
 * generating at rather than sliding to zero — a frozen number, next to a context figure and a
 * spinner that are equally still, says less that is wrong than a confident zero does.
 *
 * The resting number — what the footer shows between messages — is the finished message's own exact
 * rate over the same kind of window, and a message with too few chunks to measure that way is not
 * reported at all: the footer keeps the last rate it could stand behind rather than showing an
 * artifact of how the provider framed its stream.
 *
 * ## The trace
 *
 * The sparkline draws the same number over time, so it is sampled on a clock rather than per
 * message: one sample a second while output is being measured, plus the exact rate at each message's
 * end. It is kept across messages — it describes how the run is going, not how one reply went — and
 * it stops advancing while nothing is arriving, for the same reason the number does.
 */

/** Samples the sparkline draws from. Older ones say nothing about the speed the run has now. */
const TRACE_SAMPLES = 12;

/**
 * How often a sample is added to that trace.
 *
 * The sparkline is the same number over time, so it has to move with it — a series that only grew by
 * one bar per finished message sat still through the whole message the number beside it was
 * describing. A sample a second is fine enough to show a run changing pace and coarse enough that
 * consecutive bars are not two readings of one three-second window with most of their input shared.
 */
const TRACE_INTERVAL_MS = 1000;

/** Seeded ratio, used until the first message reports its own. Roughly English prose and code. */
const DEFAULT_CHARS_PER_TOKEN = 4;

/** Weight of the newest observation in the running ratio. High enough to follow a model switch. */
const RATIO_WEIGHT = 0.3;

/** A ratio outside this is a miscount — hidden thinking, or a message that streamed nothing. */
const RATIO_MIN = 1;
const RATIO_MAX = 12;

/** How far back the live rate looks. Long enough to be steady, short enough to still be current. */
export const WINDOW_MS = 3000;

/**
 * How long a published live number stands before a newer one replaces it.
 *
 * The footer repaints several times a second, and a per-frame rate is unreadable: the digits change
 * faster than they can be taken in, which reads as flicker rather than as information. The number
 * underneath keeps moving; only how often it is handed to the footer is held back.
 */
export const DISPLAY_HOLD_MS = 500;

/**
 * Chunks a message needs after its first before its finished rate means anything. Two or three
 * chunks say more about the provider's buffering than about the model's speed.
 */
const MIN_DELTAS = 4;

/** Before this much has streamed, the estimate is mostly jitter and the last exact rate is better. */
const MIN_LIVE_SECONDS = 0.4;

/** A message this short is dominated by scheduling noise; it would poison the trace. */
const MIN_SAMPLE_SECONDS = 0.2;

export interface RateSnapshot {
	/** Tokens per second, or undefined when nothing has been measured yet. */
	tokensPerSecond: number | undefined;
	/** True when the number is the running estimate for a message that is still streaming. */
	live: boolean;
	/** Recent rate samples over time, oldest first: what the sparkline draws. */
	trace: readonly number[];
}

/** One streamed fragment, and the interval its characters were generated over. */
interface Fragment {
	/** The previous fragment's arrival: when this one's tokens started being produced. */
	from: number;
	/** This fragment's arrival: when they finished. */
	at: number;
	chars: number;
}

export class TokenRate {
	/** The sparkline's series, kept across messages: it is a trace of the run, not of one reply. */
	private readonly trace: number[] = [];
	/** When the newest sample was taken, so streaming adds them at a pace rather than per frame. */
	private tracedAt: number | undefined;
	/** Fragments still touching the live window, oldest first. Pruned as the window moves. */
	private readonly recent: Fragment[] = [];
	private charsPerToken = DEFAULT_CHARS_PER_TOKEN;
	private streaming = false;
	private firstDeltaAt: number | undefined;
	/** Characters of the chunk that started the clock, which were generated before it did. */
	private firstChars = 0;
	/** Newest arrival, which is where the live window ends. */
	private lastAt: number | undefined;
	private chars = 0;
	private deltas = 0;
	private last: number | undefined;
	/** The live number the footer is currently showing, and when it was handed over. */
	private shown: { value: number; at: number } | undefined;

	/** An assistant message has begun. Nothing is timed until its first delta arrives. */
	start(): void {
		this.streaming = true;
		this.reset();
	}

	private reset(): void {
		this.firstDeltaAt = undefined;
		this.firstChars = 0;
		this.lastAt = undefined;
		this.chars = 0;
		this.deltas = 0;
		this.recent.length = 0;
		this.shown = undefined;
	}

	/** One streamed fragment: reply text, thinking, or tool-call arguments — all of it is output. */
	delta(text: string, now: number): void {
		if (!this.streaming || !text) return;
		if (this.firstDeltaAt === undefined) {
			this.firstDeltaAt = now;
			this.firstChars = text.length;
		} else {
			// The interval this fragment covers is the silence before it, which is when its tokens
			// were produced. The first fragment has no such interval: it opens the clock.
			this.recent.push({ from: this.lastAt ?? now, at: now, chars: text.length });
		}
		this.lastAt = now;
		this.chars += text.length;
		this.deltas++;
		this.prune();
	}

	/** Drop fragments whose whole interval now lies behind the window; they cannot contribute. */
	private prune(): void {
		if (this.lastAt === undefined) return;
		const cutoff = this.lastAt - WINDOW_MS;
		let drop = 0;
		while (drop < this.recent.length && (this.recent[drop] as Fragment).at <= cutoff) drop++;
		if (drop > 0) this.recent.splice(0, drop);
	}

	/** Characters generated after the clock started, which are the ones the window can account for. */
	private timedChars(): number {
		return this.chars - this.firstChars;
	}

	/** Whether enough of a finished message arrived after its first chunk to be worth a number. */
	private measurable(seconds: number, minSeconds: number): boolean {
		return this.firstDeltaAt !== undefined && this.deltas > MIN_DELTAS && this.timedChars() > 0 && seconds >= minSeconds;
	}

	/**
	 * The message is finished and the provider has reported its token count. A message that streamed
	 * nothing, arrived in too few chunks, or reported no tokens only clears the live state.
	 */
	finish(outputTokens: number | undefined, now: number): void {
		const startedAt = this.firstDeltaAt;
		const chars = this.chars;
		const timed = this.timedChars();
		const seconds = startedAt === undefined ? 0 : (now - startedAt) / 1000;
		const measurable = this.measurable(seconds, MIN_SAMPLE_SECONDS);
		this.streaming = false;
		this.reset();
		if (!outputTokens || outputTokens <= 0) return;

		// The ratio is a fact about the tokenizer, so it is learned from the whole message even when
		// the message was too short for its rate to be worth reporting.
		if (chars > 0) {
			const observed = Math.min(RATIO_MAX, Math.max(RATIO_MIN, chars / outputTokens));
			this.charsPerToken = this.charsPerToken * (1 - RATIO_WEIGHT) + observed * RATIO_WEIGHT;
		}

		if (!measurable) return;
		this.last = (outputTokens * (timed / chars)) / seconds;
		// The exact rate always earns a sample: it is the bar the resting number stands on.
		this.sample(this.last, now);
	}

	/** Add one sample to the sparkline's series, dropping whatever has aged out of it. */
	private sample(value: number, now: number): void {
		this.trace.push(value);
		if (this.trace.length > TRACE_SAMPLES) this.trace.splice(0, this.trace.length - TRACE_SAMPLES);
		this.tracedAt = now;
	}

	/** The run ended without a finished message — an abort, or an error mid-stream. */
	idle(): void {
		this.streaming = false;
		this.reset();
	}

	snapshot(now: number): RateSnapshot {
		const live = this.liveRate();
		if (live === undefined) {
			this.shown = undefined;
			return { tokensPerSecond: this.last, live: false, trace: this.trace };
		}
		// A newer measurement waits its turn: the footer redraws far faster than a number can be read.
		if (!this.shown || now - this.shown.at >= DISPLAY_HOLD_MS || now < this.shown.at) {
			this.shown = { value: live, at: now };
		}
		// The sparkline follows the number it sits beside, at its own slower pace.
		if (this.tracedAt === undefined || now - this.tracedAt >= TRACE_INTERVAL_MS || now < this.tracedAt) {
			this.sample(this.shown.value, now);
		}
		return { tokensPerSecond: this.shown.value, live: true, trace: this.trace };
	}

	/**
	 * Tokens per second over the trailing window, or undefined while there is not enough of one.
	 *
	 * The window ends at the newest fragment and opens three seconds before it, or at the first
	 * fragment of a younger message. Each fragment contributes the share of its characters that was
	 * generated inside that span, so a chunk covering a long silence is counted for the part of that
	 * silence the window can see rather than in full at the instant it landed.
	 */
	private liveRate(): number | undefined {
		if (!this.streaming || this.firstDeltaAt === undefined || this.lastAt === undefined) return undefined;
		const end = this.lastAt;
		const start = Math.max(end - WINDOW_MS, this.firstDeltaAt);
		const seconds = (end - start) / 1000;
		if (seconds < MIN_LIVE_SECONDS) return undefined;
		let chars = 0;
		for (const fragment of this.recent) {
			if (fragment.at <= start) continue;
			const span = fragment.at - fragment.from;
			// Two fragments in the same millisecond leave no interval to divide; they arrived inside
			// the window, so they count for what they carried.
			chars += span > 0 ? fragment.chars * Math.min(1, (fragment.at - Math.max(fragment.from, start)) / span) : fragment.chars;
		}
		return chars / this.charsPerToken / seconds;
	}
}
