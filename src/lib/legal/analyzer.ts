import type {
  AnalysisResult,
  AnalysisQuality,
  ClauseMatch,
  ClauseRegistryEntry,
  ContractType,
  EvidenceRef,
  Finding,
  FindingCategory,
  FindingSeverity,
  FindingStatus,
  MissingClauseAssessment,
  RiskScore,
  ScoringBreakdown,
  SigningRecommendation,
} from "./types";
import { CLAUSE_REGISTRY, getRelevantClauses, IMPORTANCE_WEIGHTS, SEVERITY_WEIGHTS } from "./clause-registry";

const LEGAL_SIGNAL_GROUPS = [
  /\b(?:agreement|contract|covenant|deed|instrument|undertaking)\b/i,
  /\b(?:party|parties|plaintiff|defendant|claimant|respondent|petitioner|appellant)\b/i,
  /\b(?:shall|hereby|herein|thereof|whereas|pursuant to|notwithstanding)\b/i,
  /\b(?:court|jurisdiction|statute|lawful|legal|legislation|affidavit|section \d+)\b/i,
  /\b(?:indemnif|liabilit|terminat|confidential|arbitrat|warrant|breach|obligation|governing law)\w*/i,
  /\b(?:lease|licence|license|employment|non-disclosure|terms and conditions|memorandum of understanding)\b/i,
];

export function isLikelyLegalDocument(text: string): boolean {
  const normalized = text.slice(0, 100000);
  if (normalized.trim().length < 40) return false;
  return LEGAL_SIGNAL_GROUPS.reduce((hits, pattern) => hits + Number(pattern.test(normalized)), 0) >= 2;
}

interface RiskPattern {
  type: string;
  category: FindingCategory;
  pattern: RegExp;
  severity: FindingSeverity;
  description: string;
  explanation: string;
  recommendedAction: string;
  weight: number;
  isRisk: boolean;
}

const RISK_PATTERNS: RiskPattern[] = [
  {
    type: "unlimited_liability",
    category: "liability",
    pattern: /unlimited liability|all liability|full liability|no limitation of liability/gi,
    severity: "critical",
    description: "Unlimited or uncapped liability exposure",
    explanation: "The contract imposes unlimited liability on the signing party, meaning there is no cap on potential financial exposure for damages. This could expose you to catastrophic losses far exceeding the contract value.",
    recommendedAction: "Negotiate a liability cap tied to fees paid (e.g., 12 months fees) or a fixed monetary amount. Ensure carve-outs for fraud, willful misconduct, and IP infringement.",
    weight: SEVERITY_WEIGHTS.critical,
    isRisk: true,
  },
  {
    type: "unilateral_changes",
    category: "amendment",
    pattern: /(?:may|can|will) (?:modify|change|alter|amend) (?:at any time|without notice|in its sole discretion|unilaterally)/gi,
    severity: "high",
    description: "Unilateral modification rights",
    explanation: "One party can change the contract terms without the other party's consent or adequate notice. This creates uncertainty and potential for unfavorable terms to be imposed retroactively.",
    recommendedAction: "Require mutual written agreement for all amendments. At minimum, require 30 days written notice and right to terminate if changes are unacceptable.",
    weight: SEVERITY_WEIGHTS.high,
    isRisk: true,
  },
  {
    type: "broad_indemnification",
    category: "indemnification",
    pattern: /indemnif(?:y|ication) (?:against|from) any and all (?:claims|losses|damages)/gi,
    severity: "high",
    description: "Broad indemnification of any and all claims",
    explanation: "The indemnification clause requires covering 'any and all claims' without limitation, potentially including claims arising from the other party's own negligence or third parties unrelated to your performance.",
    recommendedAction: "Limit indemnification to claims arising from your negligence, willful misconduct, or material breach. Add mutual indemnification. Exclude consequential damages.",
    weight: SEVERITY_WEIGHTS.high,
    isRisk: true,
  },
  {
    type: "automatic_renewal",
    category: "renewal",
    pattern: /automatically renew(?:s|ed|al)/gi,
    severity: "medium",
    description: "Automatic renewal without explicit consent",
    explanation: "The contract renews automatically unless notice is given within a specific window. This can trap parties in unwanted long-term commitments.",
    recommendedAction: "Negotiate mutual renewal requiring affirmative consent. If auto-renewal stays, ensure 60-90 day notice period and clear notification obligations.",
    weight: SEVERITY_WEIGHTS.medium,
    isRisk: true,
  },
  {
    type: "waiver_of_rights",
    category: "waiver",
    pattern: /waive(?:s|r of) (?:right|jury trial|class action)/gi,
    severity: "high",
    description: "Waiver of significant legal rights",
    explanation: "The contract requires giving up important legal protections such as jury trial rights or the ability to participate in class actions. These waivers may not be enforceable in all jurisdictions but create uncertainty.",
    recommendedAction: "Resist waiving jury trial or class action rights. If required, limit to specific claim types and ensure mutual waiver.",
    weight: SEVERITY_WEIGHTS.high,
    isRisk: true,
  },
  {
    type: "perpetual_obligations",
    category: "survival",
    pattern: /(?:perpetual|indefinite|survive termination)/gi,
    severity: "medium",
    description: "Perpetual or indefinitely surviving obligations",
    explanation: "Certain obligations (confidentiality, indemnity, payment) continue indefinitely after termination. While common for confidentiality, perpetual financial obligations are concerning.",
    recommendedAction: "Limit survival periods: confidentiality to 3-5 years (trade secrets excepted), indemnity to statute of limitations, financial obligations to defined periods.",
    weight: SEVERITY_WEIGHTS.medium,
    isRisk: true,
  },
  {
    type: "as_is",
    category: "warranty",
    pattern: /\bas is\b|without recourse|non-negotiable/gi,
    severity: "medium",
    description: "As-is / non-negotiable terms",
    explanation: "The contract disclaims all warranties and/or states terms are non-negotiable, shifting all risk to the signing party with no quality assurances.",
    recommendedAction: "Negotiate at minimum a professional workmanship warranty. For software/services, require conformance to specifications. Ensure terms are negotiable.",
    weight: SEVERITY_WEIGHTS.medium,
    isRisk: true,
  },
  {
    type: "one_sided_indemnity",
    category: "indemnification",
    pattern: /(?:only|solely) (?:the )?(?:contractor|customer|buyer|recipient|employee) (?:shall )?(?:indemnify|be liable)|indemnif(?:y|ication) (?:the other party|the company) for any and all/gi,
    severity: "high",
    description: "Potentially one-sided indemnity",
    explanation: "Only one party is required to indemnify, or indemnification flows only in one direction. This creates asymmetric risk allocation.",
    recommendedAction: "Negotiate mutual indemnification. Each party should indemnify for their own negligence/willful misconduct and IP infringement.",
    weight: SEVERITY_WEIGHTS.high,
    isRisk: true,
  },
  {
    type: "immediate_termination",
    category: "termination",
    pattern: /(?:may|can) terminate (?:this agreement )?(?:immediately|without cause|at any time) without (?:notice|liability)/gi,
    severity: "medium",
    description: "Termination without notice or cause",
    explanation: "One party can terminate the agreement immediately without notice or liability, creating instability and potential for abrupt business disruption.",
    recommendedAction: "Require minimum 30 days notice for termination for convenience. For cause termination should require material breach and cure period (15-30 days).",
    weight: SEVERITY_WEIGHTS.medium,
    isRisk: true,
  },
  {
    type: "broad_fee_shifting",
    category: "dispute_resolution",
    pattern: /(?:all|any) (?:legal|attorneys['']?) fees (?:and costs )?(?:shall be|will be) paid by|prevailing party.*(?:fees|costs)/gi,
    severity: "low",
    description: "Legal fee shifting may increase dispute costs",
    explanation: "The losing party pays all legal fees, which can dramatically increase the cost of disputes and discourage legitimate claims.",
    recommendedAction: "Negotiate each party bears own fees, or limit fee shifting to frivolous claims. Consider mediation/arbitration first to reduce costs.",
    weight: SEVERITY_WEIGHTS.low,
    isRisk: true,
  },
  {
    type: "broad_transfer_rights",
    category: "assignment",
    pattern: /may assign (?:this agreement|its rights) without (?:consent|notice)|assignable .* sole discretion/gi,
    severity: "low",
    description: "Broad assignment rights without consent",
    explanation: "One party can transfer the contract to third parties without consent, potentially leaving you contracted with an unknown or undesirable entity.",
    recommendedAction: "Require prior written consent for assignment (not to be unreasonably withheld). Allow assignment to affiliates and in connection with mergers/acquisitions.",
    weight: SEVERITY_WEIGHTS.low,
    isRisk: true,
  },
  {
    type: "mutual_termination",
    category: "termination",
    pattern: /(?:either|both|any) part(?:y|ies) may terminate/gi,
    severity: "informational",
    description: "Mutual termination rights",
    explanation: "Either party can terminate the agreement, providing flexibility and balanced exit rights.",
    recommendedAction: "Ensure notice periods are reasonable (30 days typical) and apply equally to both parties.",
    weight: SEVERITY_WEIGHTS.informational,
    isRisk: false,
  },
  {
    type: "limited_liability",
    category: "liability",
    pattern: /liability (?:limited to|shall not exceed)|limitation of liability/gi,
    severity: "informational",
    description: "Liability is limited",
    explanation: "The contract includes a limitation of liability clause, capping potential financial exposure.",
    recommendedAction: "Verify the cap amount is reasonable (e.g., 12 months fees, contract value). Check carve-outs for fraud, IP, confidentiality.",
    weight: SEVERITY_WEIGHTS.informational,
    isRisk: false,
  },
  {
    type: "notice_period",
    category: "notice",
    pattern: /(?:\d+|ninety|thirty|sixty)[-\s]?(?:business )?days['']? (?:prior )?written notice/gi,
    severity: "informational",
    description: "Defined notice period",
    explanation: "The contract specifies clear notice periods for termination or other actions, providing predictability.",
    recommendedAction: "Verify notice periods are reasonable (30-90 days typical) and delivery methods are practical (email acceptable).",
    weight: SEVERITY_WEIGHTS.informational,
    isRisk: false,
  },
  {
    type: "dispute_resolution",
    category: "dispute_resolution",
    pattern: /(?:binding )?arbitration|(?:mandatory )?mediation|dispute resolution/gi,
    severity: "informational",
    description: "Defined dispute resolution mechanism",
    explanation: "The contract specifies a dispute resolution process (mediation, arbitration, or litigation), avoiding uncertainty about forum.",
    recommendedAction: "Prefer mediation first, then binding arbitration. Avoid mandatory litigation in distant forums. Ensure cost allocation is fair.",
    weight: SEVERITY_WEIGHTS.informational,
    isRisk: false,
  },
  {
    type: "mutual_confidentiality",
    category: "confidentiality",
    pattern: /mutual (?:non-disclosure|confidentiality)|each (?:party|receiving party)/gi,
    severity: "informational",
    description: "Mutual confidentiality obligations",
    explanation: "Both parties have confidentiality obligations, creating balanced protection for sensitive information.",
    recommendedAction: "Verify scope covers both parties' confidential information. Check survival period (3-5 years typical).",
    weight: SEVERITY_WEIGHTS.informational,
    isRisk: false,
  },
  {
    type: "governing_law_defined",
    category: "governing_law",
    pattern: /governed by (?:and construed in accordance with )?the laws of/gi,
    severity: "informational",
    description: "Governing law is defined",
    explanation: "The contract specifies which jurisdiction's laws apply, providing legal certainty.",
    recommendedAction: "Verify the chosen jurisdiction is convenient and has favorable case law. Consider neutral jurisdictions for cross-border deals.",
    weight: SEVERITY_WEIGHTS.informational,
    isRisk: false,
  },
  {
    type: "right_to_cure",
    category: "termination",
    pattern: /(?:right|opportunity) to cure/gi,
    severity: "informational",
    description: "Right to cure a breach",
    explanation: "The breaching party has an opportunity to fix the breach before termination, providing protection against abrupt termination.",
    recommendedAction: "Verify cure period is reasonable (15-30 days typical). Ensure it applies to material breaches, not just minor ones.",
    weight: SEVERITY_WEIGHTS.informational,
    isRisk: false,
  },
];

const FAVORABLE_PATTERNS = RISK_PATTERNS.filter((p) => !p.isRisk);

const CLAUSE_PATTERNS: Record<string, RegExp> = {
  confidentiality: /confidential(?:ity)?|non[- ]disclosure|proprietary information|trade secrets|confidential information|receiving party|disclosing party|nondisclosure/gi,
  indemnification: /indemnif(?:y|ication|ies|ied)|hold harmless|defend and indemnify|indemnity|losses,? claims|third[- ]party claims/gi,
  liability: /liability|limitation of liability|disclaimer of liability|liable for|damages cap|consequential damages|direct damages|aggregate liability|cap on damages/gi,
  termination: /terminat(?:e|ion|es|ing)|cancellation|cancel this agreement|early termination|material breach|cure period|notice to terminate/gi,
  governing_law: /governing law|choice of law|jurisdiction|venue|applicable law|courts of|laws of the state|exclusive jurisdiction/gi,
  amendment: /amend(?:ment|ments|ed)?|modif(?:y|ication|ications)|written consent|variation of this agreement|changes to this agreement/gi,
  dispute_resolution: /dispute resolution|arbitration|mediation|litigation|settle disputes|binding arbitration|alternative dispute|class action|jury trial/gi,
  force_majeure: /force majeure|act of god|unforeseeable circumstances|beyond reasonable control|governmental action|natural disaster|inability to perform/gi,
  assignment: /assign(?:ment|ments|ed)?|transfer of rights|successors and assigns|delegation of duties|assignment of this agreement/gi,
  warranty: /warrant(?:y|ies|ed)|representation(?:s)? and warranties|disclaims all warranties|merchantability|fitness for a particular purpose|non-infringement/gi,
  severability: /severability|severable|invalid or unenforceable provision|invalidity of any provision/gi,
  non_compete: /non[- ]compete|non[- ]competition|restrictive covenant|competing business|non[- ]solicitation|non[- ]solicit/gi,
  intellectual_property: /intellectual property|work for hire|work made for hire|copyright|trademark|patent rights|ownership of inventions|proprietary rights|license grant|moral rights/gi,
  payment: /payment terms|invoice|invoic(?:e|ing)|compensation|fees payable|late payment|overdue payment|consideration|reimbursement|expenses|installment/gi,
  data_protection: /data protection|personal data|personal information|privacy policy|data privacy|data processing|data controller|data processor|data subject|data processing agreement/gi,
  data_security: /data security|security breach|data breach|unauthorized access|security measures|incident response|encryption|safeguards/gi,
  renewal: /automatic renewal|auto[- ]renewal|renew(?:al|s|ed)|extension of this agreement|evergreen term|renewal term/gi,
  notice: /written notice|notice period|days['']? notice|prior notice|notice of termination|notice address|deemed received/gi,
  audit_rights: /audit rights|right to audit|inspection rights|audit records|books and records|compliance audit/gi,
  subcontracting: /subcontract(?:or|ing|ors)?|third[- ]party service provider|subcontracted services|subprocessor|sub[- ]processing/gi,
  survival: /surviv(?:e|es|al)|survival of obligations|following expiration|after termination/gi,
  entire_agreement: /entire agreement|whole agreement|supersedes all prior|prior agreements|integration clause/gi,
  waiver: /waiv(?:er|e|es)|failure to enforce|no waiver|waiver of rights/gi,
  parties_and_scope: /parties hereto|hereinafter|effective date|scope of services|statement of work|deliverables|recitals/gi,
  insurance: /insurance|insured|coverage|policy|additional insured|certificate of insurance|general liability|professional liability|workers compensation/gi,
  export_controls: /export control|export license|sanctions|embargo|denied persons|restricted party|EAR|ITAR/gi,
  record_retention: /record retention|retain records|maintain records|preserve records|retention period/gi,
  right_to_cure: /right to cure|opportunity to cure|cure period|notice and cure/gi,
  most_favored_nation: /most favored nation|MFN|best pricing|price protection|no less favorable/gi,
  change_of_control: /change of control|change in control|merger|acquisition|sale of assets|transfer of ownership/gi,
};

const TYPE_DETECTION_PATTERNS: { type: ContractType; patterns: RegExp[] }[] = [
  {
    type: "nda",
    patterns: [
      /non-disclosure|confidential(?:ity) agreement|NDA/gi,
      /disclosing party|receiving party/gi,
      /confidential information.*(?:permitted )?purpose/gi,
    ],
  },
  {
    type: "employment",
    patterns: [
      /employment (?:offer|letter|agreement)|at-will/gi,
      /employee.*(?:salary|compensation|title)/gi,
      /you will (?:perform|devote)/gi,
    ],
  },
  {
    type: "service",
    patterns: [
      /professional services (?:agreement|contract)/gi,
      /provider.*client.*(?:scope|services)/gi,
      /independent contractor.*(?:not an employee)/gi,
    ],
  },
  {
    type: "freelance",
    patterns: [
      /independent contractor (?:agreement|contract)/gi,
      /contractor.*client.*(?:deliverables|services)/gi,
      /work (?:made for )?hire|work product/gi,
    ],
  },
  {
    type: "vendor",
    patterns: [
      /vendor (?:agreement|contract)|supplier (?:agreement|contract)/gi,
      /purchase order|procurement/gi,
      /goods.*services|products.*services/gi,
    ],
  },
  {
    type: "technology",
    patterns: [
      /software (?:license|agreement|development)|SaaS|platform (?:agreement|terms)/gi,
      /API|software development|source code|object code/gi,
      /subscription|cloud|hosted/gi,
    ],
  },
  {
    type: "general",
    patterns: [
      /general (?:agreement|contract)|master (?:agreement|services agreement)/gi,
      /terms and conditions|terms of service/gi,
    ],
  },
];

export function detectContractType(text: string): ContractType | null {
  const scores: Record<string, number> = { nda: 0, service: 0, freelance: 0, employment: 0, vendor: 0, technology: 0, general: 0 };
  for (const { type, patterns } of TYPE_DETECTION_PATTERNS) {
    for (const pattern of patterns) {
      const matches = text.match(pattern);
      if (matches) scores[type] += matches.length;
    }
  }
  const entries = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (entries[0][1] === 0) return null;
  return entries[0][0] as ContractType;
}

function excerptAround(text: string, start: number, end: number, pad = 72): string {
  const s = Math.max(0, start - pad);
  const e = Math.min(text.length, end + pad);
  return (s > 0 ? "…" : "") + text.slice(s, e).replace(/\s+/g, " ") + (e < text.length ? "…" : "");
}

function findMatches(text: string, pattern: RegExp): ClauseMatch[] {
  const matches: ClauseMatch[] = [];
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    matches.push({
      text: m[0],
      start: m.index,
      end: m.index + m[0].length,
      lineNumber: text.slice(0, m.index).split("\n").length,
      excerpt: excerptAround(text, m.index, m.index + m[0].length),
    });
    if (m[0].length === 0) re.lastIndex++;
  }
  return matches;
}

function unique(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const key = item.trim().replace(/\s+/g, " ");
    if (!key || key.length < 2) continue;
    const k = key.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(key);
  }
  return out;
}

export function extractEntities(text: string): Record<string, string[]> {
  const orgs =
    text.match(
      /\b[A-Z][A-Za-z0-9&.\-']+(?:\s+[A-Z][A-Za-z0-9&.\-']+){0,5}\s+(?:Ltd\.?|LLC|Inc\.?|Corp\.?|Corporation|Limited|GmbH|LLP|PLC)\b/g,
    ) ?? [];
  const money =
    text.match(
      /(?:USD|EUR|GBP|\$|€|£)\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\b\d{1,3}(?:,\d{3})*(?:\.\d{2})?\s?(?:USD|dollars|euros|pounds)\b/gi,
    ) ?? [];
  const dates =
    text.match(
      /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/g,
    ) ?? [];
  const durations =
    text.match(
      /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|thirty|sixty|ninety)\s+(?:business\s+)?(?:day|days|week|weeks|month|months|year|years)\b/gi,
    ) ?? [];
  const parties =
    text.match(
      /\b(?:Disclosing Party|Receiving Party|Client|Contractor|Vendor|Licensor|Licensee|Employer|Employee|Company|Consultant|the Parties)\b/g,
    ) ?? [];
  const law =
    text.match(
      /laws of (?:the )?(?:State of )?[A-Z][A-Za-z ]+(?:, [A-Z]{2})?|England and Wales|Delaware|California|New York|Singapore|United Kingdom/g,
    ) ?? [];
  const locations =
    text.match(
      /\b(?:London|Wilmington|New York|Delaware|California|United Kingdom|United States|Singapore|Canary Wharf)\b/g,
    ) ?? [];

  const entities: Record<string, string[]> = {};
  const map: Record<string, string[]> = {
    ORGANIZATIONS: orgs,
    MONEY_AMOUNTS: money,
    CONTRACT_DATES: dates,
    DURATIONS: durations,
    CONTRACT_PARTIES: parties,
    GOVERNING_LAW: law,
    LOCATIONS: locations,
  };
  for (const [k, v] of Object.entries(map)) {
    const u = unique(v);
    if (u.length) entities[k] = u.slice(0, 24);
  }
  return entities;
}

function extractiveSummary(text: string, n = 4): string {
  const sentences = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 40 && s.length < 420);
  if (!sentences.length) {
    return text.slice(0, 420).trim() + (text.length > 420 ? "…" : "");
  }
  const scored = sentences.map((s, i) => {
    let score = Math.min(s.length, 280) / 280;
    if (i < 3) score += 0.45;
    if (/whereas|agree|party|confidential|liability|term/i.test(s)) score += 0.3;
    return { s, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored
    .slice(0, n)
    .map((x) => x.s)
    .join(" ");
}

function generateFindingId(type: string, index: number): string {
  return `finding-${type}-${index}`;
}

function mapCategoryToFindingCategory(category: string): FindingCategory {
  const catMap: Record<string, FindingCategory> = {
    liability: "liability",
    indemnification: "indemnification",
    termination: "termination",
    amendment: "termination",
    renewal: "renewal",
    waiver: "waiver",
    survival: "data_protection",
    warranty: "data_protection",
    assignment: "dispute_resolution",
    dispute_resolution: "dispute_resolution",
    confidentiality: "confidentiality",
    governing_law: "governing_law",
    notice: "not_applicable",
    audit_rights: "not_applicable",
    subcontracting: "not_applicable",
    data_protection: "data_protection",
    data_security: "data_protection",
    non_compete: "not_applicable",
    intellectual_property: "intellectual_property",
    payment: "payment",
    parties_and_scope: "not_applicable",
    insurance: "not_applicable",
    export_controls: "not_applicable",
    record_retention: "not_applicable",
    right_to_cure: "termination",
    most_favored_nation: "not_applicable",
    change_of_control: "not_applicable",
  };
  return catMap[category] ?? "not_applicable";
}

function assessClauseStatus(
  text: string,
  clause: ClauseRegistryEntry,
  existingMatches: ClauseMatch[]
): { status: FindingStatus; evidence: EvidenceRef[]; alternativeMatches: string[]; reason: string } {
  if (existingMatches.length > 0) {
    const inDefinitionSection = existingMatches.some((m) =>
      /definition|defined terms|meanings|interpretation/i.test(text.slice(Math.max(0, m.start - 200), m.start))
    );
    if (inDefinitionSection) {
      return {
        status: "uncertain",
        evidence: existingMatches.slice(0, 2).map((m) => ({
          start: m.start,
          end: m.end,
          excerpt: m.excerpt,
          lineNumber: m.lineNumber,
        })),
        alternativeMatches: [],
        reason: "Keywords found in definitions section; cannot confirm operative clause",
      };
    }
    return {
      status: "confirmed",
      evidence: existingMatches.slice(0, 3).map((m) => ({
        start: m.start,
        end: m.end,
        excerpt: m.excerpt,
        lineNumber: m.lineNumber,
      })),
      alternativeMatches: [],
      reason: `Found ${existingMatches.length} match(es) for ${clause.name}`,
    };
  }

  const aliasMatches: string[] = [];
  for (const alias of clause.aliases) {
    const regex = new RegExp(alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    if (regex.test(text)) {
      aliasMatches.push(alias);
    }
  }

  if (aliasMatches.length > 0) {
    return {
      status: "possible",
      evidence: [],
      alternativeMatches: aliasMatches,
      reason: `Found alternative terminology: ${aliasMatches.join(", ")}`,
    };
  }

  return {
    status: "not_detected",
    evidence: [],
    alternativeMatches: [],
    reason: `No keywords or alternative terminology found for ${clause.name}`,
  };
}

function buildMissingClauseAssessments(
  text: string,
  clauses: Record<string, ClauseMatch[]>,
  contractType: ContractType | null
): MissingClauseAssessment[] {
  const relevantClauses = getRelevantClauses(contractType ?? "general");
  const assessments: MissingClauseAssessment[] = [];

  for (const clause of relevantClauses) {
    const existingMatches = clauses[clause.id] ?? [];
    const { status, evidence, alternativeMatches, reason } = assessClauseStatus(text, clause, existingMatches);

    let finalStatus = status;
    if (status === "not_detected") {
      const hasNegativeContext = clause.matchingRules.negativeKeywords?.some((kw) =>
        new RegExp(kw, "gi").test(text)
      );
      if (hasNegativeContext) {
        finalStatus = "not_applicable";
      }
    }

    assessments.push({
      clauseId: clause.id,
      clauseName: clause.name,
      status: finalStatus,
      reason,
      alternativeMatches,
      importance: clause.importance,
      relevantContractTypes: clause.relevantContractTypes,
    });
  }

  return assessments;
}

function createFindingFromRiskPattern(
  pattern: RiskPattern,
  matches: ClauseMatch[],
  index: number
): Finding {
  const evidence: EvidenceRef[] = matches.slice(0, 3).map((m) => ({
    start: m.start,
    end: m.end,
    excerpt: m.excerpt,
    lineNumber: m.lineNumber,
  }));

  return {
    id: generateFindingId(pattern.type, index),
    type: pattern.type,
    title: pattern.description,
    category: pattern.category,
    severity: pattern.severity,
    status: "confirmed",
    description: pattern.description,
    explanation: pattern.explanation,
    evidence,
    recommendedAction: pattern.recommendedAction,
    detectionMethod: "regex",
    confidence: 0.9,
    weight: pattern.weight,
    isRisk: pattern.isRisk,
  };
}

function createFindingFromFavorablePattern(
  pattern: RiskPattern,
  matches: ClauseMatch[],
  index: number
): Finding {
  const evidence: EvidenceRef[] = matches.slice(0, 2).map((m) => ({
    start: m.start,
    end: m.end,
    excerpt: m.excerpt,
    lineNumber: m.lineNumber,
  }));

return {
    id: generateFindingId(pattern.type, index),
    type: pattern.type,
    title: pattern.description,
    category: pattern.category,
    severity: pattern.severity,
    status: "confirmed",
    description: pattern.description,
    explanation: pattern.explanation,
    evidence,
    recommendedAction: pattern.recommendedAction,
    detectionMethod: "regex",
    confidence: 0.85,
    weight: pattern.weight,
    isRisk: pattern.isRisk,
  };
}

function deduplicateFindings(findings: Finding[]): Finding[] {
  const seen = new Map<string, Finding>();
  for (const finding of findings) {
    const key = `${finding.category}-${finding.type}`;
    const existing = seen.get(key);
    if (!existing || finding.severity === "critical" || (finding.isRisk && !existing.isRisk)) {
      seen.set(key, finding);
    }
  }
  return Array.from(seen.values());
}

function calculateRiskScore(
  findings: Finding[],
  missingClauses: MissingClauseAssessment[],
  entities: Record<string, string[]>,
  textStats: { wordCount: number; charCount: number; usedOCR: boolean }
): RiskScore {
  const riskPenalties: ScoringBreakdown["riskPenalties"] = [];
  const favorableContributions: ScoringBreakdown["favorableContributions"] = [];
  const missingClausePenalties: ScoringBreakdown["missingClausePenalties"] = [];
  const adjustments: ScoringBreakdown["adjustments"] = [];

  let totalRiskPenalty = 0;
  let totalFavorable = 0;

  for (const finding of findings) {
    if (finding.isRisk) {
      const penalty = Math.round(finding.weight * finding.confidence);
      totalRiskPenalty += penalty;
      riskPenalties.push({
        findingId: finding.id,
        penalty,
        reason: `${finding.title} (${finding.severity} severity, ${Math.round(finding.confidence * 100)}% confidence)`,
      });
    } else {
      const contribution = Math.round(finding.weight * finding.confidence);
      totalFavorable += contribution;
      favorableContributions.push({
        findingId: finding.id,
        contribution,
        reason: `${finding.title} (${finding.severity} severity)`,
      });
    }
  }

  for (const missing of missingClauses) {
    if (missing.status === "not_detected" || missing.status === "uncertain") {
      const penalty = IMPORTANCE_WEIGHTS[missing.importance];
      totalRiskPenalty += penalty;
      missingClausePenalties.push({
        clauseId: missing.clauseId,
        penalty,
        reason: `Missing ${missing.importance} clause: ${missing.clauseName} (${missing.reason})`,
      });
    } else if (missing.status === "confirmed" || missing.status === "possible") {
      const bonus = Math.round(IMPORTANCE_WEIGHTS[missing.importance] * 0.3);
      totalFavorable += bonus;
      favorableContributions.push({
        findingId: `present-${missing.clauseId}`,
        contribution: bonus,
        reason: `Present ${missing.importance} clause: ${missing.clauseName}`,
      });
    }
  }

  if (textStats.wordCount < 200) {
    const penalty = 10;
    totalRiskPenalty += penalty;
    adjustments.push({ name: "short_document", value: penalty, reason: "Document is very short and may be incomplete" });
  } else if (textStats.wordCount < 500) {
    const penalty = 5;
    totalRiskPenalty += penalty;
    adjustments.push({ name: "short_document", value: penalty, reason: "Document is shorter than typical contracts" });
  }

  if (!entities.CONTRACT_PARTIES?.length) {
    const penalty = 8;
    totalRiskPenalty += penalty;
    adjustments.push({ name: "unclear_parties", value: penalty, reason: "Parties are ambiguous or missing" });
  } else {
    adjustments.push({ name: "clear_parties", value: -3, reason: "Parties are clearly identified" });
  }

  if (!entities.GOVERNING_LAW?.length) {
    const penalty = 4;
    totalRiskPenalty += penalty;
    adjustments.push({ name: "missing_governing_law", value: penalty, reason: "No governing law jurisdiction found" });
  } else {
    adjustments.push({ name: "defined_governing_law", value: -2, reason: "Governing law location found" });
  }

  if (textStats.usedOCR) {
    adjustments.push({ name: "ocr_used", value: 0, reason: "OCR was used for text extraction; verify accuracy" });
  }

  const finalScore = Math.max(0, Math.min(100, Math.round(totalRiskPenalty - totalFavorable)));

  const explanationParts: string[] = [];
  if (riskPenalties.length > 0) {
    const criticalCount = riskPenalties.filter((p) => findings.find((f) => f.id === p.findingId)?.severity === "critical").length;
    const highCount = riskPenalties.filter((p) => findings.find((f) => f.id === p.findingId)?.severity === "high").length;
    explanationParts.push(`${riskPenalties.length} risk factor(s) found${criticalCount > 0 ? ` (${criticalCount} critical)` : ""}${highCount > 0 ? `, ${highCount} high` : ""}.`);
  }
  if (missingClausePenalties.length > 0) {
    explanationParts.push(`${missingClausePenalties.length} expected clause(s) not detected.`);
  }
  if (favorableContributions.length > 0) {
    explanationParts.push(`${favorableContributions.length} favorable provision(s) identified.`);
  }
  if (adjustments.length > 0) {
    const adjTotal = adjustments.reduce((sum, a) => sum + a.value, 0);
    if (adjTotal !== 0) explanationParts.push(`Adjustments: ${adjTotal > 0 ? "+" : ""}${adjTotal}.`);
  }

  const riskLabels: Record<string, string> = {
    critical: "Critical Risk",
    high: "High Risk",
    medium: "Medium Risk",
    low: "Low Risk",
    informational: "Informational",
  };

  const maxSeverity = findings.filter((f) => f.isRisk).reduce((max, f) => {
    const order = { critical: 4, high: 3, medium: 2, low: 1, informational: 0 };
    return order[f.severity] > order[max] ? f.severity : max;
  }, "informational" as FindingSeverity);

  const riskLabel = finalScore >= 70 ? "High Risk" : finalScore >= 50 ? "Elevated Risk" : finalScore >= 30 ? "Moderate Risk" : "Low Risk";

  const breakdown: ScoringBreakdown = {
    baseScore: 0,
    riskPenalties,
    favorableContributions,
    missingClausePenalties,
    adjustments,
    finalScore,
    explanation: explanationParts.join(" ") || "No significant risk factors detected.",
  };

  const quality = calculateAnalysisQuality(textStats, missingClauses, findings);

  return {
    value: finalScore,
    label: riskLabel,
    breakdown,
    analysisQuality: quality,
  };
}

function calculateAnalysisQuality(
  textStats: { wordCount: number; charCount: number; usedOCR: boolean },
  missingClauses: MissingClauseAssessment[],
  findings: Finding[]
): AnalysisQuality {
  const signals: AnalysisQuality["signals"] = [];
  let goodCount = 0;
  let warningCount = 0;
  let poorCount = 0;

  if (textStats.wordCount >= 1000) {
    signals.push({ name: "Document Length", value: `${textStats.wordCount.toLocaleString()} words`, status: "good", description: "Sufficient length for comprehensive analysis" });
    goodCount++;
  } else if (textStats.wordCount >= 300) {
    signals.push({ name: "Document Length", value: `${textStats.wordCount.toLocaleString()} words`, status: "warning", description: "Moderate length; some clauses may be abbreviated" });
    warningCount++;
  } else {
    signals.push({ name: "Document Length", value: `${textStats.wordCount.toLocaleString()} words`, status: "poor", description: "Very short document; analysis may be incomplete" });
    poorCount++;
  }

  if (textStats.usedOCR) {
    signals.push({ name: "Text Extraction", value: "OCR used", status: "warning", description: "Text extracted via OCR; verify accuracy for critical terms" });
    warningCount++;
  } else {
    signals.push({ name: "Text Extraction", value: "Native text", status: "good", description: "Selectable text extracted directly from document" });
    goodCount++;
  }

  const criticalClauses = missingClauses.filter((m) => m.importance === "critical");
  const detectedCritical = criticalClauses.filter((m) => m.status === "confirmed" || m.status === "possible").length;
  const criticalCoverage = criticalClauses.length > 0 ? detectedCritical / criticalClauses.length : 1;
  if (criticalCoverage >= 0.8) {
    signals.push({ name: "Critical Clause Coverage", value: `${detectedCritical}/${criticalClauses.length}`, status: "good", description: "Most critical clauses detected" });
    goodCount++;
  } else if (criticalCoverage >= 0.5) {
    signals.push({ name: "Critical Clause Coverage", value: `${detectedCritical}/${criticalClauses.length}`, status: "warning", description: "Some critical clauses not detected" });
    warningCount++;
  } else {
    signals.push({ name: "Critical Clause Coverage", value: `${detectedCritical}/${criticalClauses.length}`, status: "poor", description: "Many critical clauses missing or uncertain" });
    poorCount++;
  }

  const findingsWithEvidence = findings.filter((f) => f.evidence.length > 0).length;
  const evidenceCoverage = findings.length > 0 ? findingsWithEvidence / findings.length : 1;
  if (evidenceCoverage >= 0.8) {
    signals.push({ name: "Evidence Coverage", value: `${findingsWithEvidence}/${findings.length}`, status: "good", description: "Most findings have supporting evidence" });
    goodCount++;
  } else if (evidenceCoverage >= 0.5) {
    signals.push({ name: "Evidence Coverage", value: `${findingsWithEvidence}/${findings.length}`, status: "warning", description: "Some findings lack direct evidence" });
    warningCount++;
  } else {
    signals.push({ name: "Evidence Coverage", value: `${findingsWithEvidence}/${findings.length}`, status: "poor", description: "Many findings lack direct evidence" });
    poorCount++;
  }

  let level: AnalysisQuality["level"];
  let label: string;
  if (poorCount > 0 || (warningCount > 1 && goodCount === 0)) {
    level = "insufficient";
    label = "Insufficient Evidence";
  } else if (warningCount > 0) {
    level = "partial";
    label = "Partial Evidence Coverage";
  } else {
    level = "good";
    label = "Good Evidence Coverage";
  }

  const explanation = `Analysis quality is ${label.toLowerCase()}. ${signals.filter((s) => s.status !== "good").map((s) => s.description).join(" ") || "All quality signals are positive."}`;

  return { level, label, signals, explanation };
}

function recommendationLabel(riskScore: number): { label: string; recommendation: string } {
  if (riskScore <= 20)
    return {
      label: "Low Risk",
      recommendation: "Risk profile is favorable. Proceed with standard legal review before signing.",
    };
  if (riskScore <= 40)
    return {
      label: "Moderate Risk",
      recommendation: "Some risks identified. Review highlighted items and negotiate key terms before signing.",
    };
  if (riskScore <= 60)
    return {
      label: "Elevated Risk",
      recommendation: "Multiple significant risks. Negotiate material changes or obtain counsel before signing.",
    };
  if (riskScore <= 80)
    return {
      label: "High Risk",
      recommendation: "Substantial one-sided terms and gaps. Do not sign without negotiated changes and legal review.",
    };
  return {
    label: "Critical Risk",
    recommendation: "Severe structural risks. Recommend rejection or complete renegotiation with legal counsel.",
  };
}

export function getMissingClauseNames(assessments: MissingClauseAssessment[]): string[] {
  return assessments
    .filter((assessment) => assessment.status === "not_detected" || assessment.status === "uncertain")
    .map((assessment) => assessment.clauseName);
}

export function scoreDocument(
  text: string,
  clauses: Record<string, ClauseMatch[]>,
  entities: Record<string, string[]>,
  contractType: ContractType | null,
  usedOCR = false
): SigningRecommendation {
  const findings: Finding[] = [];
  let findingIndex = 0;

  for (const pattern of RISK_PATTERNS) {
    const hits = findMatches(text, pattern.pattern);
    if (!hits.length) continue;
    const finding = createFindingFromRiskPattern(pattern, hits, findingIndex++);
    findings.push(finding);
  }

  for (const pattern of FAVORABLE_PATTERNS) {
    const hits = findMatches(text, pattern.pattern);
    if (!hits.length) continue;
    const finding = createFindingFromFavorablePattern(pattern, hits, findingIndex++);
    findings.push(finding);
  }

  const deduplicatedFindings = deduplicateFindings(findings);

  const missingClauses = buildMissingClauseAssessments(text, clauses, contractType);

  const textStats = {
    wordCount: text.split(/\s+/).filter(Boolean).length,
    charCount: text.length,
    usedOCR,
  };

  const riskScore = calculateRiskScore(deduplicatedFindings, missingClauses, entities, textStats);

  const { label, recommendation } = recommendationLabel(riskScore.value);

  const safetyScore = 100 - riskScore.value;

  const legacyFindings = {
    favorable: deduplicatedFindings
      .filter((f) => !f.isRisk)
      .map((f) => ({
        type: f.id,
        description: f.description,
        weight: f.weight,
        matches: f.evidence.length,
        examples: f.evidence.slice(0, 2).map((e) => e.excerpt),
        isRisk: f.isRisk,
      })),
    risks: deduplicatedFindings
      .filter((f) => f.isRisk)
      .map((f) => ({
        type: f.id,
        description: f.description,
        weight: -f.weight,
        matches: f.evidence.length,
        examples: f.evidence.slice(0, 2).map((e) => e.excerpt),
        isRisk: f.isRisk,
      })),
  };

  const legacyMissingClauses = getMissingClauseNames(missingClauses);

  return {
    riskScore,
    missingClauses,
    summary: `${riskScore.label} (${riskScore.value}/100 risk). ${recommendation}`,
    safetyScore,
    safetyLabel: label,
    safetyRecommendation: recommendation,
    percentage: riskScore.value,
    label: riskScore.label,
    recommendation: recommendation,
    findings: legacyFindings,
    missingClausesLegacy: legacyMissingClauses,
  };
}

export function analyzeText(text: string, fileName = "document.txt", usedOCR = false): AnalysisResult {
  const cleaned = text.replace(/\0/g, "").trim();
  const clauses: Record<string, ClauseMatch[]> = {};
  for (const [name, pattern] of Object.entries(CLAUSE_PATTERNS)) {
    const hits = findMatches(cleaned, pattern);
    if (hits.length) clauses[name] = hits.slice(0, 40);
  }
  const entities = extractEntities(cleaned);
  const words = cleaned.split(/\s+/).filter(Boolean);
  const paragraphs = cleaned.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  const sentences = cleaned.split(/[.!?]+/).filter((s) => s.trim().length > 12);
  const detectedType = detectContractType(cleaned);

  const signing = scoreDocument(cleaned, clauses, entities, detectedType, usedOCR);

  const allFindings: Finding[] = [];
  let idx = 0;
  for (const pattern of RISK_PATTERNS) {
    const hits = findMatches(cleaned, pattern.pattern);
    if (!hits.length) continue;
    allFindings.push(createFindingFromRiskPattern(pattern, hits, idx++));
  }
  for (const pattern of FAVORABLE_PATTERNS) {
    const hits = findMatches(cleaned, pattern.pattern);
    if (!hits.length) continue;
    allFindings.push(createFindingFromFavorablePattern(pattern, hits, idx++));
  }

  return {
    fileName,
    clauses,
    entities,
    summary: extractiveSummary(cleaned),
    statistics: {
      wordCount: words.length,
      charCount: cleaned.length,
      paragraphCount: paragraphs.length,
      sentenceCount: sentences.length,
    },
    cleanedText: cleaned,
    signing,
    detectedType,
    findings: deduplicateFindings(allFindings),
  };
}

export function compareAnalyses(a: AnalysisResult, b: AnalysisResult) {
  const names = new Set([...Object.keys(a.clauses), ...Object.keys(b.clauses)]);
  const clauseDiff = [...names].sort().map((name) => {
    const in1 = a.clauses[name]?.length ?? 0;
    const in2 = b.clauses[name]?.length ?? 0;
    return {
      name,
      in1,
      in2,
      status: (in1 && in2 ? "both" : in1 ? "only1" : "only2") as "both" | "only1" | "only2",
    };
  });

  const setA = new Set(a.cleanedText.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const setB = new Set(b.cleanedText.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  let inter = 0;
  for (const w of setA) if (setB.has(w)) inter++;
  const similarity = Math.round((2 * inter) / Math.max(1, setA.size + setB.size) * 100);

  const critical: { title: string; detail: string; severity: "high" | "medium" | "low" }[] = [];
  const scoreDelta = a.signing.riskScore.value - b.signing.riskScore.value;
  if (Math.abs(scoreDelta) >= 8) {
    critical.push({
      title: "Risk score diverges",
      detail: `${a.fileName} risk score ${a.signing.riskScore.value} vs ${b.fileName} at ${b.signing.riskScore.value}.`,
      severity: Math.abs(scoreDelta) >= 20 ? "high" : "medium",
    });
  }
  for (const row of clauseDiff) {
    if (row.status !== "both") {
      critical.push({
        title: `${row.name.replaceAll("_", " ")} mismatch`,
        detail:
          row.status === "only1"
            ? `Present in ${a.fileName} only (${row.in1} hits).`
            : `Present in ${b.fileName} only (${row.in2} hits).`,
        severity: ["indemnification", "governing_law", "termination", "dispute_resolution", "liability", "confidentiality"].includes(row.name)
          ? "high"
          : "medium",
      });
    }
  }

  return { similarity, clauseDiff, critical: critical.slice(0, 12) };
}

export { CLAUSE_REGISTRY } from "./clause-registry";
export { IMPORTANCE_WEIGHTS, SEVERITY_WEIGHTS } from "./clause-registry";