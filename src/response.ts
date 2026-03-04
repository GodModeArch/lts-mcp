/** Response metadata for DHSUD provenance. */
export interface ApiMeta {
  source: string;
  source_url: string;
  dataset: string;
  last_synced: string;
}

export interface MetaConfig {
  lastSynced: string;
}

const DHSUD_SOURCE = "Department of Human Settlements and Urban Development (DHSUD)";
const DHSUD_URL = "https://dhsud.gov.ph/";
const DATASET_NAME = "License to Sell (LTS) Registry";

export function buildMeta(config: MetaConfig): ApiMeta {
  return {
    source: DHSUD_SOURCE,
    source_url: DHSUD_URL,
    dataset: DATASET_NAME,
    last_synced: config.lastSynced,
  };
}

/** Wrap data with metadata envelope. */
export function wrapResponse<T>(data: T, meta: ApiMeta): { _meta: ApiMeta; data: T } {
  return { _meta: meta, data };
}
