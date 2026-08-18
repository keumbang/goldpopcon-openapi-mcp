// openapi.yaml 로드·파싱·조회 헬퍼.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import type { HttpMethod } from "./signing.js";

const here = dirname(fileURLToPath(import.meta.url));

/** 스펙 경로: 환경변수 우선, 없으면 번들 사본. */
export function specPath(): string {
  return process.env.GOLDPOPCON_OPENAPI_SPEC ?? resolve(here, "../spec/openapi.yaml");
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

/**
 * quote 버킷 경로 — 스펙 §6 rate limit 표와 같은 목록이며, 그대로 "권한 플래그 없이
 * 모든 키 허용" 경로이기도 하다. /orders/history 는 붙지만 /orders/preview 는 아니다.
 */
const QUOTE_PATHS = /\/prices|\/balances|\/orders\/history/;

/** 권한 스코프 추론 — 스펙 §3 + 태그. */
function scopeFor(path: string, tags: string[]): string {
  if (QUOTE_PATHS.test(path)) return "none (모든 키 허용)";
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
      const rateBucket: "quote" | "trade" = QUOTE_PATHS.test(path) ? "quote" : "trade";
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
  /** 스펙에 이름 붙은 요청 본문 예제 전부(예: 소액매도 / 전량매도). 없으면 빈 배열. */
  requestBodyExamples: Array<{ name: string; summary: string; value: any }>;
  /** 2xx 응답 본문 예제(봉투 포함). 여러 개면 전부. 없으면 빈 배열. */
  responseExamples: Array<{ name: string; summary: string; value: any }>;
  responses: Array<{ status: string; description: string }>;
}

/** content.example / content.examples 를 이름 붙은 목록으로 평탄화한다. */
function examplesOf(json: any): Array<{ name: string; summary: string; value: any }> {
  if (!json) return [];
  const out: Array<{ name: string; summary: string; value: any }> = [];
  if (json.examples && typeof json.examples === "object") {
    for (const [name, ex] of Object.entries<any>(json.examples)) {
      if (ex && "value" in ex) out.push({ name, summary: (ex.summary ?? "").trim(), value: ex.value });
    }
  }
  if (out.length === 0 && json.example != null) out.push({ name: "example", summary: "", value: json.example });
  return out;
}

/**
 * 2xx 응답의 JSON 예제. 성공 응답 형태를 코드 작성 전에 보여주기 위한 것으로,
 * $ref 로 묶인 공용 응답(OrderCreated 등)도 펼쳐서 찾는다.
 * 매수·전량매도처럼 한 응답에 모드가 여럿이면 전부 돌려준다.
 */
function successExamples(spec: any, op: any): Array<{ name: string; summary: string; value: any }> {
  for (const status of Object.keys(op.responses ?? {})) {
    if (!/^2\d\d$/.test(status)) continue;
    const r = deref(spec, op.responses[status]);
    const found = examplesOf(r?.content?.["application/json"]);
    if (found.length > 0) return found;
  }
  return [];
}

function firstBodyExample(
  spec: any,
  requestBody: any,
): { schema: any; example: any; named: Array<{ name: string; summary: string; value: any }> } | null {
  const rb = deref(spec, requestBody);
  const json = rb?.content?.["application/json"];
  if (!json) return null;
  const schema = deref(spec, json.schema);

  // 이름 붙은 예제는 전부 보존한다 — sellAsset 처럼 일반/전량매도가 갈리는 경우
  // 첫 항목만 주면 다른 모드가 있다는 사실 자체가 가려진다.
  const named: Array<{ name: string; summary: string; value: any }> = [];
  if (json.examples && typeof json.examples === "object") {
    for (const [name, ex] of Object.entries<any>(json.examples)) {
      if (ex && "value" in ex) named.push({ name, summary: ex.summary ?? "", value: ex.value });
    }
  }

  // 예제 우선순위: content.example → content.examples 첫 항목 → schema.example → 합성
  let example = json.example ?? null;
  if (example == null && named.length > 0) example = named[0].value;
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
  return { schema, example, named };
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
        rateBucket: QUOTE_PATHS.test(path) ? "quote" : "trade",
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
        requestBodyExamples: bodyInfo?.named ?? [],
        responseExamples: successExamples(spec, op),
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
