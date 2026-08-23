const PREFER_STRICT_TOOL_SAMPLING = { type: "json_schema", strict: "prefer" } as const;

export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.PI_EXPERIMENTAL === "1";
}

/**
 * Whether schema-inspired decision tracking is active. Opt-in via
 * `PI_EXPERIMENTAL=1` (enables all experimental features) or `PI_SCHEMA_DECISIONS=1`
 * (enables only schema decisions). Default off because the subsystem adds
 * per-batch overhead and inflates the system prompt with the recent-decisions digest.
 */
export function isSchemaDecisionTrackingEnabled(): boolean {
	return process.env.PI_EXPERIMENTAL === "1" || process.env.PI_SCHEMA_DECISIONS === "1";
}

export function getExperimentalToolSampling() {
	return areExperimentalFeaturesEnabled() ? PREFER_STRICT_TOOL_SAMPLING : undefined;
}
