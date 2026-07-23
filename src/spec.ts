// openapi.yaml 로드·파싱·조회 헬퍼.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import type { HttpMethod } from "./signing.js";

const here = dirname(fileURLToPath(import.meta.url));

/** 스펙 경로: 환경변수 우선, 없으면 번들 사본. */
export function specPath(): string {
  return process.env.KEUMBANG_OPENAPI_SPEC ?? resolve(here, "../spec/openapi.yaml");
}

let cached: any = null;
export function loadSpec(): any {
  if (cached) return cached;
  cached = parse(readFileSync(specPath(), "utf8"));
  return cached;
}

/** #/a/b/c JSON pointer 해석(같은 문서 내). */
export function resolveRef(spec: any, ref: string): any {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return undefined;
  return ref
    .slice(2)
    .split("/")
    .reduce((acc, key) => (acc == null ? acc : acc[key.replace(/~1/g, "/").replace(/~0/g, "~")]), spec);
}

/** $ref 를 1단계 펼친다(중첩 ref 는 유지). */
export function deref(spec: any, node: any): any {
  if (node && typeof node === "object" && typeof node.$ref === "string") {
    return resolveRef(spec, node.$ref) ?? node;
  }
  return node;
}

const HTTP_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

export interface OperationSummary {
  operationId: string;
  method: HttpMethod;
  path: string;
  summary: string;
  tags: string[];
  scope: string;
  needsIdempotency: boolean;
  rateBucket: "quote" | "trade";
  isOpenApi: boolean;
}

/** 권한 스코프 추론 — 스펙 §3 + 태그. */
function scopeFor(path: string, tags: string[]): string {
  if (/\/prices|\/balances/.test(path)) return "none (모든 키 허용)";
  if (/\/buy\/|\/sell\/|getOrderPreview|\/preview/.test(path)) return "allow_trade";
  if (/\/virtual-accounts/.test(path)) return "allow_vacct";
  if (/\/payouts/.test(path)) return "allow_payout";
  if (tags.includes("api-keys")) return "앱 로그인 JWT (Open API 아님)";
  return "unknown";
}

function paramsOf(spec: any, op: any, pathItem: any): any[] {
  const merged = [...(pathItem.parameters ?? []), ...(op.parameters ?? [])];
  return merged.map((p) => deref(spec, p));
}

/** 모든 operation 요약. */
export function listOperations(): OperationSummary[] {
  const spec = loadSpec();
  const out: OperationSummary[] = [];
  for (const path of Object.keys(spec.paths ?? {})) {
    const pathItem = spec.paths[path];
    for (const m of HTTP_METHODS) {
      const op = pathItem[m.toLowerCase()];
      if (!op) continue;
      const tags: string[] = op.tags ?? [];
      const params = paramsOf(spec, op, pathItem);
      const needsIdempotency = params.some((p) => p?.name === "Idempotency-Key");
      const rateBucket: "quote" | "trade" = /\/prices|\/balances/.test(path) ? "quote" : "trade";
      out.push({
        operationId: op.operationId ?? `${m} ${path}`,
        method: m,
        path,
        summary: op.summary ?? "",
        tags,
        scope: scopeFor(path, tags),
        needsIdempotency,
        rateBucket,
        isOpenApi: path.startsWith("/open/"),
      });
    }
  }
  return out;
}

export interface OperationDetail extends OperationSummary {
  description: string;
  parameters: Array<{ name: string; in: string; required: boolean; description: string; schema: any }>;
  requestBodySchema: any | null;
  requestBodyExample: any | null;
  responses: Array<{ status: string; description: string }>;
}

function firstBodyExample(spec: any, requestBody: any): { schema: any; example: any } | null {
  const rb = deref(spec, requestBody);
  const json = rb?.content?.["application/json"];
  if (!json) return null;
  const schema = deref(spec, json.schema);
  // 예제 우선순위: content.example → content.examples 첫 항목 → schema.example → 합성
  let example = json.example ?? null;
  if (example == null && json.examples && typeof json.examples === "object") {
    const first: any = Object.values(json.examples)[0];
    if (first && "value" in first) example = first.value;
  }
  if (example == null) example = schema?.example ?? null;
  if (example == null && schema?.properties) {
    // 스키마 example 없으면 최소 본문을 합성.
    example = {};
    for (const key of Object.keys(schema.properties)) {
      const prop = deref(spec, schema.properties[key]);
      if (prop?.example !== undefined) example[key] = prop.example;
    }
    if (Object.keys(example).length === 0) example = null;
  }
  return { schema, example };
}

export function getOperation(operationId: string): OperationDetail | null {
  const spec = loadSpec();
  for (const path of Object.keys(spec.paths ?? {})) {
    const pathItem = spec.paths[path];
    for (const m of HTTP_METHODS) {
      const op = pathItem[m.toLowerCase()];
      if (!op || op.operationId !== operationId) continue;

      const params = paramsOf(spec, op, pathItem);
      const bodyInfo = op.requestBody ? firstBodyExample(spec, op.requestBody) : null;
      const responses = Object.keys(op.responses ?? {}).map((status) => {
        const r = deref(spec, op.responses[status]);
        return { status, description: (r?.description ?? "").trim() };
      });
      const tags: string[] = op.tags ?? [];

      return {
        operationId,
        method: m,
        path,
        summary: op.summary ?? "",
        description: (op.description ?? "").trim(),
        tags,
        scope: scopeFor(path, tags),
        needsIdempotency: params.some((p) => p?.name === "Idempotency-Key"),
        rateBucket: /\/prices|\/balances/.test(path) ? "quote" : "trade",
        isOpenApi: path.startsWith("/open/"),
        parameters: params.map((p) => ({
          name: p.name,
          in: p.in,
          required: !!p.required,
          description: (p.description ?? "").trim(),
          schema: deref(spec, p.schema),
        })),
        requestBodySchema: bodyInfo?.schema ?? null,
        requestBodyExample: bodyInfo?.example ?? null,
        responses,
      };
    }
  }
  return null;
}

export function getServers(): Array<{ url: string; description: string }> {
  const spec = loadSpec();
  return (spec.servers ?? []).map((s: any) => ({ url: s.url, description: s.description ?? "" }));
}

/** 스펙 info.description 전문(서명·한도·에러코드 산문). */
export function getInfoDescription(): string {
  return (loadSpec().info?.description ?? "").trim();
}
