import type { ContractType } from "./types";

export const CONTRACT_META = {
  nda: {
    title: "Mutual NDA",
    blurb: "Two-way confidentiality agreement.",
    fields: [],
  },
  service: {
    title: "Service agreement",
    blurb: "Professional services agreement.",
    fields: [],
  },
  freelance: {
    title: "Freelance agreement",
    blurb: "Freelance project agreement.",
    fields: [],
  },
  employment: {
    title: "Employment agreement",
    blurb: "Employment agreement.",
    fields: [],
  },
  vendor: {
    title: "Vendor agreement",
    blurb: "Vendor/supplier agreement.",
    fields: [],
  },
  technology: {
    title: "Technology license",
    blurb: "Technology license agreement.",
    fields: [],
  },
  general: {
    title: "General contract",
    blurb: "General commercial contract.",
    fields: [],
  },
};

export const BODIES = {
  nda: "NDA body template",
  service: "Service body template",
  freelance: "Freelance body template",
  employment: "Employment body template",
  vendor: "Vendor body template",
  technology: "Technology body template",
  general: "General body template",
};

export function generateContract(type: ContractType, data: Record<string, string>) {
  const body = BODIES[type] || "General body template";
  return `Generated contract for ${type}: ${body}\n`;
}
