export type ClauseMatch = {
  text: string;
  start: number;
  end: number;
  lineNumber: number;
  excerpt: string;
};

export type FindingSeverity = "critical" | "high" | "medium" | "low" | "informational";
export type FindingStatus = "confirmed" | "possible" | "uncertain" | "not_applicable" | "not_detected";
export type FindingCategory = 
  | "liability"
  | "indemnification"
  | "termination"
  | "confidentiality"
  | "governing_law"
  | "dispute_resolution"
  | "intellectual_property"
  | "payment"
  | "data_protection"
  | "waiver"
  | "survival"
  | "not_applicable"
  | "amendment"
  | "renewal"
  | "non_compete"
  | "audit_rights"
  | "assignment"
  | "warranty"
  | "force_majeure"
  | "subcontracting"
  | "other"
  | "notice";

export type EvidenceRef = {
  start: number;
  end: number;
  excerpt: string;
  lineNumber: number;
};

export type Finding = {
  id: string;
  type: string;
  title: string;
  category: FindingCategory;
  severity: FindingSeverity;
  status: FindingStatus;
  description: string;
  explanation: string;
  evidence: EvidenceRef[];
  recommendedAction: string;
  detectionMethod: "regex" | "llm_verification" | "llm_discovery" | "entity_extraction" | "heuristic";
  confidence: number;
  weight: number;
  isRisk: boolean;
};

export type ScoringBreakdown = {
  baseScore: number;
  riskPenalties: { findingId: string; penalty: number; reason: string }[];
  favorableContributions: { findingId: string; contribution: number; reason: string }[];
  missingClausePenalties: { clauseId: string; penalty: number; reason: string }[];
  adjustments: { name: string; value: number; reason: string }[];
  finalScore: number;
  explanation: string;
};

export type RiskScore = {
  value: number;
  label: string;
  breakdown: ScoringBreakdown;
  analysisQuality: AnalysisQuality;
};

export type AnalysisQuality = {
  level: "good" | "partial" | "insufficient";
  label: string;
  signals: {
    name: string;
    value: number | string;
    status: "good" | "warning" | "poor";
    description: string;
  }[];
  explanation: string;
};

export type ClauseRegistryEntry = {
  id: string;
  name: string;
  aliases: string[];
  purpose: string;
  relevantContractTypes: ContractType[];
  importance: "critical" | "important" | "standard" | "optional";
  matchingRules: {
    keywords: string[];
    negativeKeywords?: string[];
    requireContext?: string[];
  };
  limitations: string[];
};

export type MissingClauseAssessment = {
  clauseId: string;
  clauseName: string;
  status: FindingStatus;
  reason: string;
  alternativeMatches: string[];
  importance: "critical" | "important" | "standard" | "optional";
  relevantContractTypes: ContractType[];
};

export type Factor = {
  type: string;
  description: string;
  weight: number;
  matches?: number;
  examples?: string[];
  isRisk: boolean;
};

export type SigningRecommendation = {
  riskScore: RiskScore;
  missingClauses: MissingClauseAssessment[];
  summary: string;
  safetyScore: number;
  safetyLabel: string;
  safetyRecommendation: string;
  percentage: number;
  label: string;
  recommendation: string;
  findings: {
    favorable: Factor[];
    risks: Factor[];
  };
  missingClausesLegacy?: string[];
};

export type AnalysisResult = {
  fileName: string;
  clauses: Record<string, ClauseMatch[]>;
  entities: Record<string, string[]>;
  summary: string;
  statistics: {
    wordCount: number;
    charCount: number;
    paragraphCount: number;
    sentenceCount: number;
  };
  cleanedText: string;
  signing: SigningRecommendation;
  detectedType: ContractType | null;
  findings: Finding[];
};

export type ComparisonResult = {
  doc1: AnalysisResult;
  doc2: AnalysisResult;
  similarity: number;
  clauseDiff: {
    name: string;
    in1: number;
    in2: number;
    status: "both" | "only1" | "only2";
  }[];
  critical: { title: string; detail: string; severity: "high" | "medium" | "low" }[];
};

export type ContractType =
  | "nda"
  | "service"
  | "freelance"
  | "employment"
  | "vendor"
  | "technology"
  | "general";

export type ContractField = {
  key: string;
  label: string;
  placeholder: string;
  multiline?: boolean;
};
