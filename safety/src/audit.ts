export interface AuditEntry {
	time: number;
	kind: "bash" | "tool";
	identity: string;
	verdict: "allow" | "ask";
	/** The classifier's own description of the call, in its own words. */
	explanation: string;
}

export class SafetyAudit {
	readonly entries: AuditEntry[] = [];

	record(entry: Omit<AuditEntry, "time">, now = Date.now()): void {
		this.entries.push({ ...entry, time: now });
	}

	clear(): void {
		this.entries.length = 0;
	}

	format(): string {
		if (this.entries.length === 0) return "No classifier decisions have been recorded in this session.";
		return this.entries.map((entry) =>
			`${new Date(entry.time).toISOString()}  ${entry.verdict.toUpperCase()}  ${entry.kind} ${entry.identity} — ${entry.explanation}`,
		).join("\n");
	}
}
