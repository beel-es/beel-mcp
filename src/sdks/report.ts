/**
 * The official SDKs as `beel_get_setup_status` reports them: per SDK, what an
 * agent needs to recognise the project's stack and start (the files that mark
 * it, the install command, the docs and guides as Markdown), plus the
 * catalogue's own sentences on when to use one and what to do without one.
 * Those sentences are passed through word for word: the docs site owns them.
 */

import type { Sdk, SdkCatalog } from './catalog.js';

/** The status of an SDK to start with; any other status carries its note. */
export const RECOMMENDED_STATUS = 'recommended';

export interface SdkEntry {
  id: string;
  status: string;
  /** Files whose presence in a project marks this stack. */
  detect: string[];
  install: string;
  /** The SDK's docs page, as Markdown when the catalogue has it. */
  docs?: string;
  /** Guides written against the SDK, as Markdown. */
  guides: string[];
  /** Why not to start with it; only for an SDK that is not recommended. */
  note?: string;
}

export interface SdkGuidance {
  /** When to use an SDK, as the catalogue words it. */
  directive: string;
  /** What to do when no SDK fits the stack, as the catalogue words it. */
  fallback: string;
  openapi_url: string;
}

export interface SdkReport {
  sdks: SdkEntry[];
  sdk_guidance: SdkGuidance;
}

function entry(sdk: Sdk): SdkEntry {
  const docs = sdk.docs_md_url ?? sdk.docs_url ?? undefined;
  const note = sdk.status !== RECOMMENDED_STATUS && sdk.status_note ? sdk.status_note : undefined;
  return {
    id: sdk.id,
    status: sdk.status,
    detect: sdk.detect,
    install: sdk.install.command,
    ...(docs ? { docs } : {}),
    guides: sdk.guides.map((guide) => guide.md_url),
    ...(note ? { note } : {}),
  };
}

export function sdkReport(catalog: SdkCatalog): SdkReport {
  return {
    sdks: catalog.sdks.map(entry),
    sdk_guidance: {
      directive: catalog.directive,
      fallback: catalog.fallback.text,
      openapi_url: catalog.fallback.openapi_url,
    },
  };
}

/** The output schema of {@link SdkReport}, as `beel_get_setup_status` advertises it. */
export const SDK_REPORT_SCHEMA = {
  sdks: {
    type: 'array',
    description:
      "The official SDKs. Match the project's files against detect, then install the one " +
      'whose status is recommended; a note says why another is not.',
    items: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        status: { type: 'string' },
        detect: { type: 'array', items: { type: 'string' } },
        install: { type: 'string' },
        docs: { type: 'string' },
        guides: { type: 'array', items: { type: 'string' } },
        note: { type: 'string' },
      },
      required: ['id', 'status', 'detect', 'install', 'guides'],
    },
  },
  sdk_guidance: {
    type: 'object',
    properties: {
      directive: { type: 'string' },
      fallback: { type: 'string' },
      openapi_url: { type: 'string' },
    },
    required: ['directive', 'fallback', 'openapi_url'],
  },
} as const;
