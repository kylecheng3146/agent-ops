import type {
  AcceptanceCriterion,
  AgentOpsConfig,
  AgentTask,
  EvidenceRequirement,
  InstallManifest,
  ManagedHookRecord,
  ManagedMarkerRecord,
  ManagedPathRecord,
  PathMapping,
  SecurityException,
  ValidationFailure,
  ValidationResult,
  VerificationCommand,
  VerificationEvidence
} from "../contracts.js";
import {
  CONFIG_SCHEMA_VERSION,
  EVIDENCE_SCHEMA_VERSION,
  MANIFEST_SCHEMA_VERSION,
  TASK_SCHEMA_VERSION
} from "../contracts.js";

type UnknownRecord = Record<string, unknown>;

const ID_PATTERN = /^[a-z][a-z0-9-]{0,127}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const WINDOWS_RESERVED_SEGMENT =
  /^(?:aux|com[1-9]|con|lpt[1-9]|nul|prn)(?:\..*)?$/i;
const PROFILE_VALUES = new Set(["advisory", "core", "guardrails", "loop"]);
const EVIDENCE_KINDS = new Set(["exit-code", "file", "test-count"]);
const SCOPE_VALUES = new Set(["project", "user"]);
const HARNESS_VALUES = new Set(["claude", "codex", "opencode"]);
// opencode's plugin is a managed artifact, not a ManagedHookRecord entry.
const HOOK_HARNESS_VALUES = new Set(["claude", "codex"]);
const HOOK_EVENT_VALUES = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SubagentStart",
  "SubagentStop",
  "Stop"
]);
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_EXIT_CODE = 4_294_967_295;

function failure(
  code: string,
  path: string,
  message: string
): ValidationFailure {
  return {
    ok: false,
    errors: [{ code, path, message }]
  };
}

function success<T>(value: T): ValidationResult<T> {
  return { ok: true, value, errors: [] };
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstUnknownField(
  value: UnknownRecord,
  allowed: readonly string[]
): string | undefined {
  const allowedSet = new Set(allowed);
  return Object.keys(value)
    .filter((key) => !allowedSet.has(key))
    .sort()[0];
}

function unknownFieldFailure(
  value: UnknownRecord,
  allowed: readonly string[],
  path: string
): ValidationFailure | undefined {
  const unknown = firstUnknownField(value, allowed);
  return unknown === undefined
    ? undefined
    : failure(
        "UNKNOWN_FIELD",
        `${path}.${unknown}`,
        `Unknown field: ${unknown}`
      );
}

function validateRoot(
  value: unknown,
  allowed: readonly string[],
  expectedVersion: number
): UnknownRecord | ValidationFailure {
  if (!isRecord(value)) {
    return failure("INVALID_TYPE", "$", "Expected an object.");
  }
  if (value.schemaVersion !== expectedVersion) {
    return failure(
      "SCHEMA_VERSION_UNSUPPORTED",
      "$.schemaVersion",
      `Expected schemaVersion ${expectedVersion}.`
    );
  }
  return unknownFieldFailure(value, allowed, "$") ?? value;
}

function isFailure(
  value: UnknownRecord | ValidationFailure
): value is ValidationFailure {
  return "ok" in value && value.ok === false;
}

function isNonEmptyString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !value.includes("\0") &&
    value.trim().length > 0
  );
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function isStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] !== "string") {
      return false;
    }
  }
  return true;
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    return false;
  }
  if (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    value.includes("\\") ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }
  if (value === ".") {
    return true;
  }
  const segments = value.split("/");
  return (
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !segment.endsWith(".") &&
        !WINDOWS_RESERVED_SEGMENT.test(segment) &&
        /^[A-Za-z0-9._-]+$/.test(segment)
    ) && !value.startsWith("//")
  );
}

function isIsoTimestamp(value: unknown): value is string {
  // Deliberately excludes leap-second values because JavaScript Date cannot
  // order them reliably for startedAt/finishedAt evidence comparisons.
  if (typeof value !== "string") {
    return false;
  }
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value
    );
  if (match === null) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[10]);
  const isLeapYear =
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    isLeapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31
  ][month - 1];

  return (
    Number.isInteger(year) &&
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    daysInMonth !== undefined &&
    day >= 1 &&
    day <= daysInMonth &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59 &&
    second >= 0 &&
    second <= 59 &&
    offsetHour >= 0 &&
    offsetHour <= 23 &&
    offsetMinute >= 0 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

function hasUniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function validateEvidenceRequirement(
  value: unknown,
  path: string
): ValidationResult<EvidenceRequirement> {
  if (!isRecord(value)) {
    return failure("INVALID_TYPE", path, "Expected an evidence object.");
  }
  const unknown = unknownFieldFailure(value, ["kind", "minimum"], path);
  if (unknown !== undefined) {
    return unknown;
  }
  if (typeof value.kind !== "string" || !EVIDENCE_KINDS.has(value.kind)) {
    return failure(
      "INVALID_EVIDENCE_KIND",
      `${path}.kind`,
      "Unsupported evidence kind."
    );
  }
  if (
    value.minimum !== undefined &&
    (!Number.isSafeInteger(value.minimum) || (value.minimum as number) < 0)
  ) {
    return failure(
      "INVALID_MINIMUM",
      `${path}.minimum`,
      "minimum must be a non-negative integer."
    );
  }
  return success(value as unknown as EvidenceRequirement);
}

function validateCommand(
  value: unknown,
  path: string
): ValidationResult<VerificationCommand> {
  if (!isRecord(value)) {
    return failure("INVALID_TYPE", path, "Expected a verifier command object.");
  }

  const isShell = value.shell === true;
  const allowed = isShell
    ? [
        "acknowledgeRisk",
        "args",
        "command",
        "cwd",
        "evidence",
        "id",
        "required",
        "shell",
        "timeoutMs"
      ]
    : [
        "args",
        "command",
        "cwd",
        "evidence",
        "id",
        "required",
        "shell",
        "timeoutMs"
      ];
  const unknown = unknownFieldFailure(value, allowed, path);
  if (unknown !== undefined) {
    return unknown;
  }

  if (isShell && value.acknowledgeRisk !== true) {
    return failure(
      "SHELL_ACK_REQUIRED",
      `${path}.acknowledgeRisk`,
      "Shell execution requires acknowledgeRisk: true."
    );
  }
  if (value.shell !== undefined && value.shell !== false && value.shell !== true) {
    return failure(
      "INVALID_SHELL_MODE",
      `${path}.shell`,
      "shell must be true or false."
    );
  }
  if (!isIdentifier(value.id)) {
    return failure("INVALID_ID", `${path}.id`, "Invalid command ID.");
  }
  if (!isNonEmptyString(value.command)) {
    return failure(
      "INVALID_COMMAND",
      `${path}.command`,
      "command must be a non-empty string."
    );
  }
  if (
    !isStringArray(value.args) ||
    value.args.some((argument) => argument.includes("\0"))
  ) {
    return failure(
      "INVALID_ARGS",
      `${path}.args`,
      "args must be an array of strings."
    );
  }
  if (!isSafeRelativePath(value.cwd)) {
    return failure(
      "INVALID_RELATIVE_PATH",
      `${path}.cwd`,
      "cwd must be a portable project-relative path."
    );
  }
  if (typeof value.required !== "boolean") {
    return failure(
      "INVALID_TYPE",
      `${path}.required`,
      "required must be boolean."
    );
  }
  if (
    value.timeoutMs !== undefined &&
    (!Number.isSafeInteger(value.timeoutMs) ||
      (value.timeoutMs as number) <= 0 ||
      (value.timeoutMs as number) > MAX_TIMEOUT_MS)
  ) {
    return failure(
      "INVALID_TIMEOUT",
      `${path}.timeoutMs`,
      "timeoutMs must be a positive integer."
    );
  }
  const evidence = validateEvidenceRequirement(value.evidence, `${path}.evidence`);
  if (!evidence.ok) {
    return evidence;
  }
  return success(value as unknown as VerificationCommand);
}

function validatePathMapping(
  value: unknown,
  path: string,
  commandIds: ReadonlySet<string>
): ValidationResult<PathMapping> {
  if (!isRecord(value)) {
    return failure("INVALID_TYPE", path, "Expected a path mapping object.");
  }
  const unknown = unknownFieldFailure(value, ["path", "verifierIds"], path);
  if (unknown !== undefined) {
    return unknown;
  }
  if (!isSafeRelativePath(value.path)) {
    return failure(
      "INVALID_RELATIVE_PATH",
      `${path}.path`,
      "Mapping path must be project-relative."
    );
  }
  if (
    !isStringArray(value.verifierIds) ||
    !value.verifierIds.every(isIdentifier)
  ) {
    return failure(
      "INVALID_VERIFIER_REFERENCE",
      `${path}.verifierIds`,
      "verifierIds must contain valid IDs."
    );
  }
  if (!hasUniqueStrings(value.verifierIds)) {
    return failure(
      "DUPLICATE_ID",
      `${path}.verifierIds`,
      "verifierIds must be unique."
    );
  }
  const unknownReference = value.verifierIds.find((id) => !commandIds.has(id));
  if (unknownReference !== undefined) {
    return failure(
      "UNKNOWN_VERIFIER_REFERENCE",
      `${path}.verifierIds`,
      `Unknown verifier reference: ${unknownReference}`
    );
  }
  return success(value as unknown as PathMapping);
}

function validateSecurityException(
  value: unknown,
  path: string
): ValidationResult<SecurityException> {
  if (!isRecord(value)) {
    return failure("INVALID_TYPE", path, "Expected a security exception object.");
  }
  const unknown = unknownFieldFailure(
    value,
    ["expiresAt", "reason", "ruleId", "scope"],
    path
  );
  if (unknown !== undefined) {
    return unknown;
  }
  if (!isIdentifier(value.ruleId)) {
    return failure("INVALID_ID", `${path}.ruleId`, "Invalid rule ID.");
  }
  if (
    !isSafeRelativePath(value.scope) ||
    value.scope === "." ||
    value.scope.includes("*")
  ) {
    return failure(
      "UNSAFE_EXCEPTION_SCOPE",
      `${path}.scope`,
      "Exception scope must be a bounded project-relative path."
    );
  }
  if (!isIsoTimestamp(value.expiresAt)) {
    return failure(
      "INVALID_TIMESTAMP",
      `${path}.expiresAt`,
      "expiresAt must be an ISO timestamp."
    );
  }
  if (!isNonEmptyString(value.reason)) {
    return failure(
      "INVALID_REASON",
      `${path}.reason`,
      "Exception reason is required."
    );
  }
  return success(value as unknown as SecurityException);
}

export function validateConfig(value: unknown): ValidationResult<AgentOpsConfig> {
  const root = validateRoot(value, [
    "features",
    "pathMappings",
    "profiles",
    "schemaVersion",
    "securityExceptions",
    "verification"
  ], CONFIG_SCHEMA_VERSION);
  if (isFailure(root)) {
    return root;
  }

  if (isRecord(root.verification) && Array.isArray(root.verification.commands)) {
    for (const [index, command] of root.verification.commands.entries()) {
      if (
        isRecord(command) &&
        command.shell === true &&
        command.acknowledgeRisk !== true
      ) {
        return failure(
          "SHELL_ACK_REQUIRED",
          `$.verification.commands[${index}].acknowledgeRisk`,
          "Shell execution requires acknowledgeRisk: true."
        );
      }
    }
  }

  if (!Array.isArray(root.profiles)) {
    return failure("INVALID_TYPE", "$.profiles", "profiles must be an array.");
  }
  for (const [index, profile] of root.profiles.entries()) {
    if (typeof profile !== "string" || !PROFILE_VALUES.has(profile)) {
      return failure(
        "INVALID_PROFILE",
        `$.profiles[${index}]`,
        `Unsupported profile: ${String(profile)}`
      );
    }
  }
  if (!hasUniqueStrings(root.profiles as string[])) {
    return failure("DUPLICATE_ID", "$.profiles", "Profiles must be unique.");
  }

  if (!isRecord(root.features)) {
    return failure(
      "INVALID_TYPE",
      "$.features",
      "features must be an object."
    );
  }
  const featuresUnknown = unknownFieldFailure(
    root.features,
    ["stopVerification"],
    "$.features"
  );
  if (featuresUnknown !== undefined) {
    return featuresUnknown;
  }
  if (!isRecord(root.features.stopVerification)) {
    return failure(
      "INVALID_TYPE",
      "$.features.stopVerification",
      "stopVerification must be an object."
    );
  }
  const stopVerificationUnknown = unknownFieldFailure(
    root.features.stopVerification,
    ["enabled"],
    "$.features.stopVerification"
  );
  if (stopVerificationUnknown !== undefined) {
    return stopVerificationUnknown;
  }
  if (typeof root.features.stopVerification.enabled !== "boolean") {
    return failure(
      "INVALID_FEATURE",
      "$.features.stopVerification.enabled",
      "stopVerification.enabled must be a boolean."
    );
  }

  if (!isRecord(root.verification)) {
    return failure(
      "INVALID_TYPE",
      "$.verification",
      "verification must be an object."
    );
  }
  const verificationUnknown = unknownFieldFailure(
    root.verification,
    ["commands"],
    "$.verification"
  );
  if (verificationUnknown !== undefined) {
    return verificationUnknown;
  }
  if (!Array.isArray(root.verification.commands)) {
    return failure(
      "INVALID_TYPE",
      "$.verification.commands",
      "commands must be an array."
    );
  }

  const commandIds = new Set<string>();
  for (const [index, commandValue] of root.verification.commands.entries()) {
    const command = validateCommand(
      commandValue,
      `$.verification.commands[${index}]`
    );
    if (!command.ok) {
      return command;
    }
    if (commandIds.has(command.value.id)) {
      return failure(
        "DUPLICATE_ID",
        `$.verification.commands[${index}].id`,
        `Duplicate command ID: ${command.value.id}`
      );
    }
    commandIds.add(command.value.id);
  }

  if (
    root.features.stopVerification.enabled === true &&
    root.verification.commands.length === 0
  ) {
    return failure(
      "STOP_VERIFICATION_COMMANDS_REQUIRED",
      "$.features.stopVerification.enabled",
      "Stop verification requires at least one verification command."
    );
  }

  if (!Array.isArray(root.pathMappings)) {
    return failure(
      "INVALID_TYPE",
      "$.pathMappings",
      "pathMappings must be an array."
    );
  }
  for (const [index, mappingValue] of root.pathMappings.entries()) {
    const mapping = validatePathMapping(
      mappingValue,
      `$.pathMappings[${index}]`,
      commandIds
    );
    if (!mapping.ok) {
      return mapping;
    }
  }

  if (!Array.isArray(root.securityExceptions)) {
    return failure(
      "INVALID_TYPE",
      "$.securityExceptions",
      "securityExceptions must be an array."
    );
  }
  for (const [index, exceptionValue] of root.securityExceptions.entries()) {
    const exception = validateSecurityException(
      exceptionValue,
      `$.securityExceptions[${index}]`
    );
    if (!exception.ok) {
      return exception;
    }
  }

  return success(root as unknown as AgentOpsConfig);
}

function validateCriterion(
  value: unknown,
  path: string
): ValidationResult<AcceptanceCriterion> {
  if (!isRecord(value)) {
    return failure("INVALID_TYPE", path, "Expected a criterion object.");
  }
  const unknown = unknownFieldFailure(
    value,
    ["description", "id", "verifierIds"],
    path
  );
  if (unknown !== undefined) {
    return unknown;
  }
  if (!isIdentifier(value.id)) {
    return failure("INVALID_ID", `${path}.id`, "Invalid criterion ID.");
  }
  if (!isNonEmptyString(value.description)) {
    return failure(
      "INVALID_DESCRIPTION",
      `${path}.description`,
      "Criterion description is required."
    );
  }
  if (
    !isStringArray(value.verifierIds) ||
    value.verifierIds.length === 0 ||
    !value.verifierIds.every(isIdentifier)
  ) {
    return failure(
      "INVALID_VERIFIER_REFERENCE",
      `${path}.verifierIds`,
      "A criterion requires at least one valid verifier ID."
    );
  }
  if (!hasUniqueStrings(value.verifierIds)) {
    return failure(
      "DUPLICATE_ID",
      `${path}.verifierIds`,
      "Criterion verifier IDs must be unique."
    );
  }
  return success(value as unknown as AcceptanceCriterion);
}

export function validateTask(value: unknown): ValidationResult<AgentTask> {
  const root = validateRoot(
    value,
    ["criteria", "id", "schemaVersion", "title"],
    TASK_SCHEMA_VERSION
  );
  if (isFailure(root)) {
    return root;
  }
  if (!isIdentifier(root.id)) {
    return failure("INVALID_ID", "$.id", "Invalid task ID.");
  }
  if (!isNonEmptyString(root.title)) {
    return failure("INVALID_TITLE", "$.title", "Task title is required.");
  }
  if (
    !Array.isArray(root.criteria) ||
    root.criteria.length < 2 ||
    root.criteria.length > 5
  ) {
    return failure(
      "CRITERIA_COUNT_INVALID",
      "$.criteria",
      "A task requires two to five criteria."
    );
  }
  const criterionIds = new Set<string>();
  for (const [index, criterionValue] of root.criteria.entries()) {
    const criterion = validateCriterion(
      criterionValue,
      `$.criteria[${index}]`
    );
    if (!criterion.ok) {
      return criterion;
    }
    if (criterionIds.has(criterion.value.id)) {
      return failure(
        "DUPLICATE_ID",
        `$.criteria[${index}].id`,
        `Duplicate criterion ID: ${criterion.value.id}`
      );
    }
    criterionIds.add(criterion.value.id);
  }
  return success(root as unknown as AgentTask);
}

export function validateTaskAgainstConfig(
  taskValue: unknown,
  configValue: unknown
): ValidationResult<AgentTask> {
  const config = validateConfig(configValue);
  if (!config.ok) {
    return config;
  }
  const task = validateTask(taskValue);
  if (!task.ok) {
    return task;
  }
  const commandIds = new Set(
    config.value.verification.commands.map((command) => command.id)
  );
  for (const [criterionIndex, criterion] of task.value.criteria.entries()) {
    const unknownReference = criterion.verifierIds.find(
      (verifierId) => !commandIds.has(verifierId)
    );
    if (unknownReference !== undefined) {
      return failure(
        "UNKNOWN_VERIFIER_REFERENCE",
        `$.criteria[${criterionIndex}].verifierIds`,
        `Unknown verifier reference: ${unknownReference}`
      );
    }
  }
  return task;
}

export function validateEvidence(
  value: unknown
): ValidationResult<VerificationEvidence> {
  const root = validateRoot(value, [
    "argv",
    "commandId",
    "configHash",
    "criterionId",
    "cwd",
    "exitCode",
    "finishedAt",
    "schemaVersion",
    "scope",
    "startedAt",
    "taskId",
    "testCount",
    "toolVersions"
  ], EVIDENCE_SCHEMA_VERSION);
  if (isFailure(root)) {
    return root;
  }

  for (const field of ["taskId", "criterionId", "commandId"] as const) {
    if (!isIdentifier(root[field])) {
      return failure("INVALID_ID", `$.${field}`, `Invalid ${field}.`);
    }
  }
  if (
    !isStringArray(root.argv) ||
    root.argv.length === 0 ||
    root.argv.some((argument) => argument.includes("\0"))
  ) {
    return failure("INVALID_ARGS", "$.argv", "argv must contain safe strings.");
  }
  if (!isSafeRelativePath(root.cwd)) {
    return failure(
      "INVALID_RELATIVE_PATH",
      "$.cwd",
      "cwd must be project-relative."
    );
  }
  if (typeof root.scope !== "string" || !SCOPE_VALUES.has(root.scope)) {
    return failure("INVALID_SCOPE", "$.scope", "Unsupported evidence scope.");
  }
  if (!isIsoTimestamp(root.startedAt)) {
    return failure(
      "INVALID_TIMESTAMP",
      "$.startedAt",
      "startedAt must be a supported RFC 3339 timestamp."
    );
  }
  if (!isIsoTimestamp(root.finishedAt)) {
    return failure(
      "INVALID_TIMESTAMP",
      "$.finishedAt",
      "finishedAt must be a supported RFC 3339 timestamp."
    );
  }
  if (
    Date.parse(root.finishedAt as string) < Date.parse(root.startedAt as string)
  ) {
    return failure(
      "INVALID_TIMESTAMP_ORDER",
      "$.finishedAt",
      "finishedAt must not precede startedAt."
    );
  }
  if (
    root.exitCode !== null &&
    (!Number.isSafeInteger(root.exitCode) ||
      (root.exitCode as number) < 0 ||
      (root.exitCode as number) > MAX_EXIT_CODE)
  ) {
    return failure(
      "INVALID_EXIT_CODE",
      "$.exitCode",
      "exitCode must be null or a non-negative integer."
    );
  }
  if (
    root.testCount !== null &&
    (!Number.isSafeInteger(root.testCount) || (root.testCount as number) < 0)
  ) {
    return failure(
      "INVALID_TEST_COUNT",
      "$.testCount",
      "testCount must be null or a non-negative integer."
    );
  }
  if (
    !isRecord(root.toolVersions) ||
    !Object.values(root.toolVersions).every(isNonEmptyString)
  ) {
    return failure(
      "INVALID_TOOL_VERSIONS",
      "$.toolVersions",
      "toolVersions must map tool names to versions."
    );
  }
  if (typeof root.configHash !== "string" || !HASH_PATTERN.test(root.configHash)) {
    return failure(
      "INVALID_HASH",
      "$.configHash",
      "configHash must be a lowercase SHA-256 digest."
    );
  }
  return success(root as unknown as VerificationEvidence);
}

function validateManagedPath(
  value: unknown,
  path: string,
  allowedFields: readonly string[]
): ValidationResult<ManagedPathRecord> {
  if (!isRecord(value)) {
    return failure("INVALID_TYPE", path, "Expected a managed path record.");
  }
  const unknown = unknownFieldFailure(value, allowedFields, path);
  if (unknown !== undefined) {
    return unknown;
  }
  if (!isIdentifier(value.id)) {
    return failure("INVALID_ID", `${path}.id`, "Invalid managed entry ID.");
  }
  if (!isSafeRelativePath(value.path)) {
    return failure(
      "INVALID_RELATIVE_PATH",
      `${path}.path`,
      "Managed paths must be project-relative."
    );
  }
  if (value.path === ".") {
    return failure(
      "INVALID_RELATIVE_PATH",
      `${path}.path`,
      "Managed paths must not target the project root."
    );
  }
  if (typeof value.hash !== "string" || !HASH_PATTERN.test(value.hash)) {
    return failure(
      "INVALID_HASH",
      `${path}.hash`,
      "Managed path hash must be a lowercase SHA-256 digest."
    );
  }
  if (value.owner !== "agent-ops") {
    return failure(
      "INVALID_OWNER",
      `${path}.owner`,
      "Managed entries must be owned by agent-ops."
    );
  }
  return success(value as unknown as ManagedPathRecord);
}

function validateManagedMarker(
  value: unknown,
  path: string
): ValidationResult<ManagedMarkerRecord> {
  const base = validateManagedPath(value, path, [
    "endMarker",
    "hash",
    "id",
    "owner",
    "path",
    "startMarker"
  ]);
  if (!base.ok) {
    return base;
  }
  const marker = value as UnknownRecord;
  if (
    !isNonEmptyString(marker.startMarker) ||
    !isNonEmptyString(marker.endMarker) ||
    marker.startMarker === marker.endMarker
  ) {
    return failure(
      "INVALID_MARKER_BOUNDARY",
      path,
      "Marker boundaries must be distinct non-empty strings."
    );
  }
  return success(value as unknown as ManagedMarkerRecord);
}

function validateManagedHook(
  value: unknown,
  path: string
): ValidationResult<ManagedHookRecord> {
  if (!isRecord(value)) {
    return failure("INVALID_TYPE", path, "Expected a managed hook record.");
  }
  const unknown = unknownFieldFailure(
    value,
    ["events", "harness", "id", "owner", "path"],
    path
  );
  if (unknown !== undefined) {
    return unknown;
  }
  if (!isIdentifier(value.id)) {
    return failure("INVALID_ID", `${path}.id`, "Invalid managed entry ID.");
  }
  if (!isSafeRelativePath(value.path) || value.path === ".") {
    return failure(
      "INVALID_RELATIVE_PATH",
      `${path}.path`,
      "Managed paths must be project-relative."
    );
  }
  if (
    typeof value.harness !== "string" ||
    !HOOK_HARNESS_VALUES.has(value.harness)
  ) {
    return failure(
      "INVALID_HARNESS",
      `${path}.harness`,
      "Hook records must name a single harness."
    );
  }
  if (
    !isStringArray(value.events) ||
    value.events.length === 0 ||
    new Set(value.events).size !== value.events.length ||
    value.events.some((event) => !HOOK_EVENT_VALUES.has(event))
  ) {
    return failure(
      "INVALID_HOOK_EVENTS",
      `${path}.events`,
      "Hook records must list distinct supported events."
    );
  }
  if (value.owner !== "agent-ops") {
    return failure(
      "INVALID_OWNER",
      `${path}.owner`,
      "Managed entries must be owned by agent-ops."
    );
  }
  return success(value as unknown as ManagedHookRecord);
}

export function validateManifest(
  value: unknown
): ValidationResult<InstallManifest> {
  const root = validateRoot(
    value,
    ["artifacts", "harness", "hooks", "markers", "schemaVersion", "scope"],
    MANIFEST_SCHEMA_VERSION
  );
  if (isFailure(root)) {
    return root;
  }
  if (typeof root.scope !== "string" || !SCOPE_VALUES.has(root.scope)) {
    return failure("INVALID_SCOPE", "$.scope", "Unsupported install scope.");
  }
  if (
    !Array.isArray(root.harness) ||
    root.harness.length === 0 ||
    !root.harness.every(
      (id) => typeof id === "string" && HARNESS_VALUES.has(id)
    ) ||
    new Set(root.harness).size !== root.harness.length
  ) {
    return failure(
      "INVALID_HARNESS",
      "$.harness",
      "Harness must be a non-empty list of unique supported harnesses."
    );
  }
  if (!Array.isArray(root.artifacts) || !Array.isArray(root.markers)) {
    return failure(
      "INVALID_TYPE",
      "$.artifacts",
      "artifacts and markers must be arrays."
    );
  }

  const entryIds = new Set<string>();
  const artifactPaths = new Set<string>();
  for (const [index, artifactValue] of root.artifacts.entries()) {
    const artifact = validateManagedPath(
      artifactValue,
      `$.artifacts[${index}]`,
      ["hash", "id", "owner", "path"]
    );
    if (!artifact.ok) {
      return artifact;
    }
    if (entryIds.has(artifact.value.id)) {
      return failure(
        "DUPLICATE_ID",
        `$.artifacts[${index}].id`,
        `Duplicate manifest entry ID: ${artifact.value.id}`
      );
    }
    const artifactPathKey = artifact.value.path.toLowerCase();
    if (artifactPaths.has(artifactPathKey)) {
      return failure(
        "DUPLICATE_OWNERSHIP",
        `$.artifacts[${index}].path`,
        `Artifact path is owned more than once: ${artifact.value.path}`
      );
    }
    entryIds.add(artifact.value.id);
    artifactPaths.add(artifactPathKey);
  }

  const markerBoundaries = new Set<string>();
  for (const [index, markerValue] of root.markers.entries()) {
    const marker = validateManagedMarker(
      markerValue,
      `$.markers[${index}]`
    );
    if (!marker.ok) {
      return marker;
    }
    if (entryIds.has(marker.value.id)) {
      return failure(
        "DUPLICATE_ID",
        `$.markers[${index}].id`,
        `Duplicate manifest entry ID: ${marker.value.id}`
      );
    }
    const markerPathKey = marker.value.path.toLowerCase();
    if (artifactPaths.has(markerPathKey)) {
      return failure(
        "DUPLICATE_OWNERSHIP",
        `$.markers[${index}].path`,
        `A whole-file artifact and marker cannot own the same path: ${marker.value.path}`
      );
    }
    const startBoundary = [markerPathKey, marker.value.startMarker].join(
      "\0"
    );
    const endBoundary = [markerPathKey, marker.value.endMarker].join("\0");
    if (
      markerBoundaries.has(startBoundary) ||
      markerBoundaries.has(endBoundary)
    ) {
      return failure(
        "DUPLICATE_OWNERSHIP",
        `$.markers[${index}]`,
        `Marker boundary is owned more than once: ${marker.value.path}`
      );
    }
    entryIds.add(marker.value.id);
    markerBoundaries.add(startBoundary);
    markerBoundaries.add(endBoundary);
  }

  if (root.hooks !== undefined) {
    if (!Array.isArray(root.hooks)) {
      return failure("INVALID_TYPE", "$.hooks", "hooks must be an array.");
    }
    const hookPaths = new Set<string>();
    for (const [index, hookValue] of root.hooks.entries()) {
      const hook = validateManagedHook(hookValue, `$.hooks[${index}]`);
      if (!hook.ok) {
        return hook;
      }
      const hookPathKey = hook.value.path.toLowerCase();
      if (entryIds.has(hook.value.id)) {
        return failure(
          "DUPLICATE_ID",
          `$.hooks[${index}].id`,
          `Duplicate manifest entry ID: ${hook.value.id}`
        );
      }
      if (artifactPaths.has(hookPathKey) || hookPaths.has(hookPathKey)) {
        return failure(
          "DUPLICATE_OWNERSHIP",
          `$.hooks[${index}].path`,
          `Hook path is owned more than once: ${hook.value.path}`
        );
      }
      entryIds.add(hook.value.id);
      hookPaths.add(hookPathKey);
    }
  }
  return success(root as unknown as InstallManifest);
}
