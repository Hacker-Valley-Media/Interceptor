export type ConditionId = "interceptor" | "axi"
export type SuiteId = "public_parity" | "interceptor_differentiation"
export type TaskKind = "public" | "fixture"
export type ValidatorType = "text_in_answer" | "text_all_of_in_answer" | "text_any_of_in_answer" | "requires_judge"

export interface CommandPolicy {
  requireAnyPrefix?: string[]
  forbidAnyPrefix?: string[]
  forbidSubstrings?: string[]
}

export interface PreflightConfig {
  commands: string[]
}

export interface ConditionDef {
  id: ConditionId
  name: string
  tool: string
  toolCommand?: string
  agentsMd: string
  daemon: "auto" | "explicit"
  daemonStart?: string
  daemonStop?: string
  healthCommand?: string
  commandPolicy?: CommandPolicy
  preflight?: PreflightConfig
}

export interface ValidatorDef {
  type: ValidatorType
  expected?: string[]
}

export interface TaskDef {
  id: string
  name: string
  category: string
  kind: TaskKind
  prompt: string
  url?: string
  judgeHint?: string
  validator: ValidatorDef
}

export interface TaskSuiteFile {
  suite: SuiteId
  tasks: TaskDef[]
}

export interface ModelsConfig {
  agent: {
    provider: string
    model: string
    reasoningEffort: string
    sandbox: "read-only" | "workspace-write" | "danger-full-access"
    approvalPolicy: string
    outputSchema: string
    lockMode: string
  }
  judge: {
    provider: string
    model: string
    reasoningEffort: string
    sandbox: "read-only" | "workspace-write" | "danger-full-access"
    approvalPolicy: string
    outputSchema: string
    lockMode: string
  }
  costModel: {
    enabled: boolean
    reason?: string
  }
}

export interface RunPolicy {
  defaultRepeats: number
  publishedRepeats: number
  timeoutSeconds: number
  randomizeOrder: boolean
  freshStatePerRun: boolean
  sameWorkstationRequired: boolean
  sameBrowserRequired: boolean
  sameNetworkRequired: boolean
  suitesReportedSeparately: boolean
}

export interface ScoringConfig {
  primaryMetrics: string[]
  secondaryMetrics: string[]
  interceptorTelemetry: string[]
}

export interface BenchConfig {
  conditions: Record<ConditionId, ConditionDef>
  models: ModelsConfig
  runPolicy: RunPolicy
  scoring: ScoringConfig
  suites: Record<SuiteId, TaskDef[]>
}

export interface InterceptorTelemetry {
  tree_count: number
  text_count: number
  state_count: number
  diff_count: number
  net_log_count: number
  net_headers_count: number
  scene_count: number
  os_input_count: number
  monitor_count: number
  replay_generated: boolean
  replay_used: boolean
}

export interface UsageMetrics {
  input_tokens: number
  input_tokens_cached: number
  input_tokens_uncached: number
  output_tokens: number
  reasoning_tokens: number
  total_cost_usd: number | null
  wall_clock_seconds: number
  turn_count: number
  command_count: number
  error_count: number
  command_log: string[]
  interceptor_telemetry?: InterceptorTelemetry
}

export interface DeterministicGrade {
  pass: boolean
  score: number
  reason: string
  mode: "deterministic"
}

export interface JudgeGrade {
  pass: boolean
  score: number
  reason: string
  confidence: string
  mode: "judge"
  judge_model: string
}

export type GradeResult = DeterministicGrade | JudgeGrade

export interface RunSpec {
  suite: SuiteId
  condition: ConditionId
  taskId: string
  run: number
}

export interface RunEnvironment {
  os: string
  browser: string
  interceptorVersion?: string
  axiVersion?: string
  interceptorCommit?: string
  axiCommit?: string
  fixtureVersion?: string
  codexModel: string
}

export interface AgentFinalMessage {
  answer: string
  evidence: string[]
}

export interface RunResult {
  suite: SuiteId
  condition: ConditionId
  taskId: string
  taskName: string
  run: number
  timestamp: string
  model: string
  environment: RunEnvironment
  usage: UsageMetrics
  grade: GradeResult
  final: AgentFinalMessage
  artifactDir: string
  setupError?: string
}

export interface HeadlineSummaryRow {
  condition: ConditionId
  suite: SuiteId
  successRate: number
  avgSeconds: number
  avgTurns: number
  avgCommands: number
  avgInputTokens: number
  avgOutputTokens: number
  avgCost: number | null
}
