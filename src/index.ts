#!/usr/bin/env node
// 금방 Open API 코딩 어시스턴트 MCP 서버 (stdio).
//
// 노출 도구:
//   list_endpoints          엔드포인트 목록(권한·멱등성·rate 버킷 포함)
//   get_endpoint            단일 엔드포인트 상세(파라미터·본문 스키마·요청/성공 응답 예제·응답 코드)
//   list_error_codes        에러 코드 표 + 상태 코드별 재시도 판단 + 함정
//   signing_guide           JWT 서명 절차(query_hash 분기 등) — 막히는 지점
//   generate_signed_request 언어별 완결형 서명 요청 코드 생성
//   sign_request            secret 로 실제 JWT 계산(로컬 전용) — 디버깅
//   verify_signature        토큰 로컬 검증 — 401 원인 진단
// 리소스:
//   keumbang://openapi.yaml  전체 스펙 원문
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  listOperations,
  getOperation,
  getServers,
  getInfoDescription,
  specPath,
} from "./spec.js";
import { generateCode, type Language } from "./codegen.js";
import { signRequest, verifySignature, type HttpMethod } from "./signing.js";

const server = new McpServer({ name: "keumbang-openapi-mcp", version: "0.2.0" });

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const errText = (s: string) => ({ content: [{ type: "text" as const, text: s }], isError: true });

/** op.path 의 {name} 을 pathParams 로 치환. 미치환 남으면 에러 문자열 반환(성공 시 null). */
function substitutePath(path: string, pathParams?: Record<string, string>): { url: string; error: string | null } {
  const url = path.replace(/\{([^}]+)\}/g, (_, name) => pathParams?.[name] ?? `{${name}}`);
  const missing = url.match(/\{([^}]+)\}/g);
  return { url, error: missing ? `path 파라미터 누락: ${missing.join(", ")} — pathParams 로 지정(예: {"asset":"gold"})` : null };
}

/**
 * server 인자를 base url 로 해석한다.
 *
 * 스펙의 servers 에는 production 만 있다 — staging 은 공개 스펙에서 빼고, 대신
 * 실자금이 움직이지 않는 /open/demo/v1 경로(demoBuyAsset·demoSellAsset)를 쓴다.
 * 그래서 "staging" 요청은 해석하지 않고 데모 경로로 안내한다.
 *
 * 실패를 throw 하지 않고 error 로 돌려준다 — 도구 핸들러가 errText 로 통일해
 * 응답하기 위해서다(throw 하면 호출부에 따라 그대로 터진다).
 */
function resolveServerUrl(server?: string): { url: string | null; error: string | null } {
  const servers = getServers();
  const fallback = servers[0]?.url ?? "https://api.goldpopcon.com/api";
  if (!server) return { url: fallback, error: null };
  if (server === "staging") {
    const found = servers.find((s) => /staging-backend/.test(s.url));
    if (!found) {
      return {
        url: null,
        error:
          "staging 서버는 공개 스펙에 없다. 실거래 없이 연동을 검증하려면 " +
          "operationId 를 demoBuyAsset / demoSellAsset(/open/demo/v1)으로 바꿔 쓴다 — " +
          "서명·인증·응답 형식은 실거래와 같고 자금만 움직이지 않는다.",
      };
    }
    return { url: found.url, error: null };
  }
  if (server === "production") {
    return { url: servers.find((s) => /goldpopcon\.com/.test(s.url))?.url ?? fallback, error: null };
  }
  return { url: server, error: null }; // 임의 url 허용
}

// ── list_endpoints ──────────────────────────────────────────────────────────
server.tool(
  "list_endpoints",
  "금방 Open API 엔드포인트 목록. 각 항목의 권한 스코프·멱등성 필요 여부·rate limit 버킷을 함께 준다.",
  { openApiOnly: z.boolean().optional().describe("true 면 /open/* 만. 기본 true — 현재 스펙은 전부 /open/* 이라 결과가 같다") },
  async ({ openApiOnly }) => {
    const only = openApiOnly ?? true;
    const ops = listOperations().filter((o) => (only ? o.isOpenApi : true));
    const lines = ops.map(
      (o) =>
        `${o.method.padEnd(6)} ${o.path}\n  op=${o.operationId}  scope=${o.scope}  ` +
        `idem=${o.needsIdempotency ? "필수" : "-"}  rate=${o.rateBucket}\n  ${o.summary}`,
    );
    return text(`# 엔드포인트 (${ops.length})\n\n${lines.join("\n\n")}`);
  },
);

// ── get_endpoint ────────────────────────────────────────────────────────────
server.tool(
  "get_endpoint",
  "단일 엔드포인트 상세 — 설명, 파라미터, 요청 본문 스키마와 예제, 응답 상태, 권한·멱등성.",
  { operationId: z.string().describe("operationId. 예: buyAsset, getPrices, getPriceHistory") },
  async ({ operationId }) => {
    const op = getOperation(operationId);
    if (!op) return errText(`operationId '${operationId}' 없음. list_endpoints 로 확인.`);
    const parts: string[] = [];
    parts.push(`# ${op.operationId}\n${op.method} ${op.path}`);
    parts.push(`권한: ${op.scope}   멱등성: ${op.needsIdempotency ? "필수(Idempotency-Key, UUID v4)" : "불필요"}   rate: ${op.rateBucket}`);
    if (op.summary) parts.push(`## 요약\n${op.summary}`);
    if (op.description) parts.push(`## 설명\n${op.description}`);
    if (op.parameters.length) {
      const rows = op.parameters.map(
        (p) => `- ${p.name} (${p.in}${p.required ? ", 필수" : ""}): ${p.description}` +
          (p.schema?.enum ? `  [${p.schema.enum.join("|")}]` : "") +
          (p.schema?.type ? `  <${p.schema.type}>` : ""),
      );
      parts.push(`## 파라미터\n${rows.join("\n")}`);
    }
    if (op.requestBodySchema) {
      parts.push(`## 요청 본문 스키마\n\`\`\`json\n${JSON.stringify(op.requestBodySchema, null, 2)}\n\`\`\``);
    }
    if (op.requestBodyExamples.length > 1) {
      // 예제가 여럿이면 전부 보여준다 — sellAsset 의 전량매도(sell_all)처럼
      // 첫 예제만 주면 다른 모드가 있다는 사실이 가려진다.
      const blocks = op.requestBodyExamples.map(
        (ex) => `### ${ex.name}${ex.summary ? ` — ${ex.summary}` : ""}\n\`\`\`json\n${JSON.stringify(ex.value, null, 2)}\n\`\`\``,
      );
      parts.push(`## 요청 본문 예제\n\n${blocks.join("\n\n")}`);
    } else if (op.requestBodyExample) {
      parts.push(`## 요청 본문 예제\n\`\`\`json\n${JSON.stringify(op.requestBodyExample, null, 2)}\n\`\`\``);
    }
    if (op.responses.length) {
      parts.push(`## 응답\n${op.responses.map((r) => `- ${r.status}: ${r.description.split("\n")[0]}`).join("\n")}`);
    }
    if (op.responseExamples.length === 1) {
      parts.push(`## 성공 응답 예제\n\`\`\`json\n${JSON.stringify(op.responseExamples[0].value, null, 2)}\n\`\`\``);
    } else if (op.responseExamples.length > 1) {
      const blocks = op.responseExamples.map(
        (ex) => `### ${ex.name}${ex.summary ? ` — ${ex.summary.replace(/\n/g, " ")}` : ""}\n\`\`\`json\n${JSON.stringify(ex.value, null, 2)}\n\`\`\``,
      );
      parts.push(`## 성공 응답 예제\n\n${blocks.join("\n\n")}`);
    }
    parts.push(`\n> 서명 코드는 generate_signed_request(operationId="${op.operationId}", language=...) 로 생성.`);
    return text(parts.join("\n\n"));
  },
);

// ── list_error_codes ────────────────────────────────────────────────────────
server.tool(
  "list_error_codes",
  "금방 Open API 에러 코드 표와 함정(잔액 부족은 400 P0001, 인증 실패는 error=null 401, 503 fail-closed 등). 상태 코드별 재시도 판단표 포함.",
  {},
  async () => {
    const table = [
      "# 에러 코드",
      "| 코드 | 상태 | 의미 |",
      "|---|---|---|",
      "| U0005 | 400 | 입력 형식 오류(수량 누락·0 이하, 자산명 오류, 매수에 sell_all 지정) |",
      "| P0001 | 400 | 가용 현금·가용 수량 부족, 주문 금액 0원, 전량매도할 잔량 없음 |",
      "| M0001 | 400 | 최소 주문 수량 미달 (금 0.001g, 은 0.1g) |",
      "| M0002 | 400 | 주문 단위(0.001g) 위반 |",
      "| M0003 | 400 | 최소 주문 금액(100원) 미달 |",
      "| N0001 | 404 | 리소스 없음(마켓 등) |",
      "| L0001 | 403 | 금액 한도 초과(건당/일일). error 에 limit_krw·requested_krw·remaining_krw |",
      "| S0001 | 500·502·503 | 서버 또는 상류 시스템 오류 |",
      "",
      "## 상태 코드별 재시도 판단",
      "| 상태 | 뜻 | 재시도 |",
      "|---|---|---|",
      "| 400 | 요청 자체가 성립 안 됨 | 무의미. 수량·잔고를 고쳐야 함 |",
      "| 401 | 서명 실패 | 서명 재계산 후. verify_signature 로 원인 확인 |",
      "| 403 | 권한 없음 또는 금액 한도 초과 | 한도는 다음 날/한도 조정 전까지 무의미 |",
      "| 409 | 같은 Idempotency-Key 가 처리 중 | 잠시 후 **같은 키**로 |",
      "| 429 | rate limit | Retry-After 만큼 대기 |",
      "| 500 | 체결 중 실패(자금이 움직였을 수 있음) | getBalances 로 반영 확인 후 **같은 키**로 |",
      "| 503 | 요청이 실행되지 않음(fail-closed) | 그대로 **같은 키**로 재시도 안전 |",
      "",
      "## 함정",
      "- **잔액 부족 = 400 P0001**(500 아님). 주문 경로가 체결 전에 가용 현금·가용 수량을 검사한다. 두 값 모두 **미체결 주문에 묶인 몫을 뺀** 가용분이라 총 잔고가 충분해도 거절될 수 있다. 주문 전 getOrderPreview 로 최대치 확인.",
      "- **500 은 '내다가 깨진 주문'**. 사전 검사를 통과한 뒤 상류 이체·원장 처리가 실패한 경우다. 재시도 전 getBalances 로 실제 반영 여부 확인.",
      "- **503 은 실행 안 된 요청**. 멱등/nonce 저장소 장애, 시세 미수신, 전량매도 잔량 조회 실패, 일일 사용분 조회 실패 — 전부 fail-closed라 값을 추정하지 않는다.",
      "- **인증 실패 = 401, error=null**. 미들웨어 에러는 코드 없이 message 만. '키 없음'과 '서명 불일치'를 구분하지 않는다(access_key 탐색 차단). 로컬 재계산이 유일한 진단 → verify_signature.",
      "- **권한 없음 = 403**. 403 은 서명이 유효했다는 뜻(401 과 구분).",
      "- **429 = rate limit**. quote 600/분, trade 60/분. Retry-After 참고.",
      "- **체결 이력 조회 API 가 없다.** 주문 응답의 order_id·matched_id·total_cash_krw·matched_at 을 클라이언트가 보관해야 한다. 현재 잔고만 getBalances 로 조회 가능.",
      "- **키 관리(발급·폐기) 경로는 이 스펙에 없다.** 앱 내부 API 이며 K0001~K0006 은 그쪽 코드다.",
    ];
    return text(table.join("\n"));
  },
);

// ── signing_guide ───────────────────────────────────────────────────────────
server.tool(
  "signing_guide",
  "요청 서명(JWT + query_hash) 절차. 개발자가 가장 많이 막히는 지점 — 업비트 예제를 그대로 옮기면 전부 401 이 나는 이유 포함.",
  {},
  async () => {
    const guide = `# 금방 Open API 요청 서명

모든 요청은 \`Authorization: Bearer <JWT>\`. 이 JWT 는 로그인 토큰이 아니라 **요청 하나마다 새로 만드는 서명**이다.

## payload
\`\`\`
{ "access_key": "gpk_...", "nonce": "<uuid-v4>", "iat": <unix초>, "exp": <unix초>,
  "query_hash": "<sha512 hex>", "query_hash_alg": "SHA512" }
\`\`\`
- 서명 = HMAC-SHA256, 키 = \`secret_key\` 문자열 **그대로의 바이트**(\`sk_\` 접두사 포함, base64 디코딩·접두사 제거 금지)
- alg = HS256

## query_hash — 업비트와 갈리는 지점
| 메서드 | 해시 입력 |
|---|---|
| POST/PUT/PATCH | **요청 본문 raw 바이트** |
| GET/DELETE | 정규화 querystring |
| 본문·쿼리 둘 다 없음 | query_hash / query_hash_alg **생략** |

업비트는 POST 도 JSON 을 querystring 으로 바꿔 해시하지만 그 변환은 float 표기(\`1.0\` vs \`1\`)에서 모호하다. 그래서 **본문은 보낸 바이트 그대로 해시**한다. 업비트 예제를 그대로 옮기면 전부 401.

**핵심**: 직렬화한 문자열을 그대로 서명하고 그대로 전송한다. 서명 후 재직렬화하면 공백 하나 차이로도 실패.

## 정규화 querystring (GET/DELETE)
1. 키 오름차순
2. 같은 키에 값 여럿이면 값도 오름차순
3. \`k=v\` 를 \`&\` 로 연결
4. **퍼센트 디코딩된 값** 사용(\`from=...T00%3A00%3A00Z\` → \`from=...T00:00:00Z\`)

해시는 SHA512 **소문자 hex**.

## 시각 클레임 · nonce
- \`iat\`, \`exp\` 필수. 없으면 401
- \`exp - iat\` ≤ 60초
- \`iat\` 가 현재보다 30초 넘게 미래면 401(시계 오차 허용)
- \`nonce\` 는 1회용, 유효 180초. 재사용 401

**클라이언트 시계를 NTP 로 동기화할 것.** 허용 스큐가 30초뿐이라 시계가 앞선 서버는 모든 요청이 401 이 된다. 서명이 맞는데 전량 401 이면 시계부터 확인.

## 첫 통합 순서 — 서명 모드를 난이도 순으로 검증
1. \`getPrices\` (본문·쿼리 없음 → query_hash 생략) — 200 이면 HMAC 키 처리와 시각 클레임이 맞다는 뜻
2. \`getOrderPreview\` (쿼리 해시) — 정규화 querystring 검증
3. \`buyAsset\` / \`sellAsset\` (본문 해시) — 직렬화 바이트 일치 검증

1번을 먼저 통과시키면 401 원인이 서명 로직인지 해시 입력인지 갈린다.

## 멱등성
자금 이동(\`/buy/* /sell/* /virtual-accounts /payouts\`)은 \`Idempotency-Key\`(UUID v4) 필수. 재시도는 **같은 키**. 새 키 = 이중 체결.

## 401 진단
서버는 원인을 구분하지 않는다. 로컬에서 재계산해 대조하는 것이 유일 → \`verify_signature\`.

> 코드가 필요하면 generate_signed_request(language=python|javascript|go|curl).`;
    return text(guide);
  },
);

// ── generate_signed_request ─────────────────────────────────────────────────
server.tool(
  "generate_signed_request",
  "특정 엔드포인트를 호출하는 완결형 서명 코드를 생성한다(python/javascript/go/curl). query_hash 분기·멱등성 헤더를 메서드에 맞게 자동 반영.",
  {
    operationId: z.string().describe("operationId. 예: sellAsset, getPriceHistory"),
    language: z.enum(["python", "javascript", "go", "curl"]).describe("생성 언어"),
    body: z.any().optional().describe("POST 요청 본문 객체. 생략 시 스펙 예제 사용"),
    query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe("GET 쿼리 파라미터"),
    pathParams: z.record(z.string()).optional().describe('경로 파라미터. 예: {"asset":"gold"} (buy/sell)'),
    server: z
      .string()
      .optional()
      .describe(
        "production | 임의 base url. 기본 production(스펙의 유일한 서버). " +
          "실거래 없이 시험하려면 server 가 아니라 operationId 를 demoBuyAsset/demoSellAsset 으로 바꾼다",
      ),
    ttlSeconds: z.number().optional().describe("JWT 수명(초). 기본 30, 최대 60"),
  },
  async ({ operationId, language, body, query, pathParams, server: srv, ttlSeconds }) => {
    const op = getOperation(operationId);
    if (!op) return errText(`operationId '${operationId}' 없음.`);
    if (!op.isOpenApi) return errText(`'${operationId}' 는 Open API 경로가 아니다(앱 로그인 JWT 경로). 서명 코드 대상 아님.`);
    const { url: subPath, error: pathErr } = substitutePath(op.path, pathParams);
    if (pathErr) return errText(pathErr);
    const { url: base, error: srvErr } = resolveServerUrl(srv);
    if (srvErr || !base) return errText(srvErr ?? "서버 url 해석 실패");
    const fullUrl = base + subPath;
    const effectiveBody =
      op.method === "POST" || op.method === "PUT" || op.method === "PATCH"
        ? (body ?? op.requestBodyExample ?? {})
        : undefined;
    const code = generateCode(language as Language, {
      operationId: op.operationId,
      method: op.method as HttpMethod,
      fullUrl,
      body: effectiveBody,
      query: query as Record<string, string | number | boolean> | undefined,
      needsIdempotency: op.needsIdempotency,
      ttlSeconds,
    });

    // 필수 쿼리 파라미터 누락 경고 — 서명은 유효하나 서버가 400 을 낼 수 있다.
    const provided = new Set(Object.keys(query ?? {}));
    const missingQuery = op.parameters.filter((p) => p.in === "query" && p.required && !provided.has(p.name)).map((p) => p.name);
    const warn = missingQuery.length
      ? `\n\n> ⚠️ 필수 쿼리 파라미터 누락: ${missingQuery.join(", ")}. 서명은 유효하지만 서버가 400(U0005)을 낼 수 있다. query 인자에 채워 다시 생성하라.`
      : "";

    const lang = language === "curl" ? "bash" : language;
    return text(`# ${operationId} — ${language}\n\n\`\`\`${lang}\n${code}\`\`\`\n\n> ACCESS_KEY/SECRET_KEY 를 실제 키로 바꾼다. secret 은 코드 안에서만 쓰이고 전송되지 않는다.${warn}`);
  },
);

// ── sign_request ────────────────────────────────────────────────────────────
server.tool(
  "sign_request",
  "실제 키로 요청 하나의 JWT 를 로컬 계산한다(디버깅용). secret_key 는 로컬에서만 쓰이고 어디로도 전송되지 않는다. 결과에 JWT·query_hash·바로 쓸 curl 을 준다.",
  {
    operationId: z.string(),
    accessKey: z.string().describe("gpk_... 액세스 키"),
    secretKey: z.string().describe("sk_... 시크릿 키. 로컬 계산에만 사용"),
    body: z.any().optional().describe("POST 본문 객체. 생략 시 스펙 예제"),
    query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
    pathParams: z.record(z.string()).optional().describe('경로 파라미터. 예: {"asset":"gold"}'),
    server: z
      .string()
      .optional()
      .describe(
        "production | 임의 base url. 기본 production(스펙의 유일한 서버). " +
          "실거래 없이 시험하려면 operationId 를 demoBuyAsset/demoSellAsset 으로 바꾼다",
      ),
    ttlSeconds: z.number().optional(),
  },
  async ({ operationId, accessKey, secretKey, body, query, pathParams, server: srv, ttlSeconds }) => {
    const op = getOperation(operationId);
    if (!op) return errText(`operationId '${operationId}' 없음.`);
    const { url: subPath, error: pathErr } = substitutePath(op.path, pathParams);
    if (pathErr) return errText(pathErr);
    const method = op.method as HttpMethod;
    const bodyMode = method === "POST" || method === "PUT" || method === "PATCH";
    const rawBody = bodyMode ? JSON.stringify(body ?? op.requestBodyExample ?? {}) : undefined;
    const res = signRequest({
      accessKey,
      secretKey,
      method,
      rawBody,
      query: query as any,
      ttlSeconds,
    });
    const { url: base, error: srvErr } = resolveServerUrl(srv);
    if (srvErr || !base) return errText(srvErr ?? "서버 url 해석 실패");
    const url = base + subPath;
    const idemLine = op.needsIdempotency ? `  -H "Idempotency-Key: $(uuidgen)" \\\n` : "";
    const curlCmd = bodyMode
      ? `curl -sS -X ${method} "${url}" \\\n  -H "Authorization: ${res.authorization}" \\\n  -H "Content-Type: application/json" \\\n${idemLine}  --data-raw '${rawBody}'`
      : `curl -sS -X ${method} "${url}${res.hashInput ? "?" + res.hashInput : ""}" \\\n  -H "Authorization: ${res.authorization}"`;
    const out = [
      `# ${operationId} 서명 결과`,
      `iat=${res.iat}  exp=${res.exp}  nonce=${res.nonce}`,
      `query_hash: ${res.queryHash ?? "(생략)"}`,
      res.hashInput ? `해시 입력: ${res.hashInput}` : "",
      `\n## JWT\n${res.jwt}`,
      `\n## payload\n\`\`\`json\n${JSON.stringify(res.payload, null, 2)}\n\`\`\``,
      `\n## curl\n\`\`\`bash\n${curlCmd}\n\`\`\``,
      `\n> JWT 수명은 ${ttlSeconds ?? 30}초. 만료되면 다시 생성. nonce 는 1회용이라 재전송 시 401.`,
    ].filter(Boolean);
    return text(out.join("\n"));
  },
);

// ── verify_signature ────────────────────────────────────────────────────────
server.tool(
  "verify_signature",
  "이미 만든 JWT 를 서버와 같은 순서로 로컬 검증해 401 원인을 짚는다. secret_key·전송할 본문/쿼리를 주면 query_hash 불일치까지 진단한다.",
  {
    token: z.string().describe("검증할 JWT(Bearer 접두사 있어도 됨)"),
    secretKey: z.string().describe("sk_... 시크릿 키"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    rawBody: z.string().optional().describe("실제 전송한(할) 본문 raw 문자열. POST 계열 query_hash 대조용"),
    query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe("실제 전송한(할) 쿼리. GET 계열 대조용"),
  },
  async ({ token, secretKey, method, rawBody, query }) => {
    const res = verifySignature({
      token,
      secretKey,
      method: method as HttpMethod,
      rawBody,
      query: query as any,
    });
    const lines = res.checks.map((c) => `${c.pass ? "✅" : "❌"} ${c.name}: ${c.detail}`);
    const verdict = res.valid ? "✅ 서버 통과 예상" : "❌ 서버 401 예상 — 아래 실패 항목 확인";
    return text(
      `# 서명 검증\n\n${verdict}\n\n${lines.join("\n")}\n\n## 디코딩된 payload\n\`\`\`json\n${JSON.stringify(res.decodedPayload, null, 2)}\n\`\`\``,
    );
  },
);

// ── call_api (조회 전용 라이브 호출, opt-in) ─────────────────────────────────
//
// 다중 안전장치:
//   1. env KEUMBANG_MCP_ALLOW_LIVE=true 없으면 도구 등록 자체 안 함
//   2. 화이트리스트 — 조회(GET) 4개만. buy/sell/payout/vacct 는 라이브 금지
//   3. 서버 고정 — 인자로 못 바꾼다(임의 url 거부)
//   4. GET 강제 — 자금 이동 메서드 원천 차단
//
// 3의 대상은 스펙의 유일한 서버인 production 이다. 예전에는 staging 고정이었으나
// staging 은 공개 스펙에서 빠졌고(대신 /open/demo/v1 을 쓴다), 그 상태로 두면
// 해석이 항상 실패해 도구가 아예 동작하지 않았다. 화이트리스트가 조회 4개(GET)뿐이라
// production 을 읽어도 자금은 움직이지 않는다.
const READONLY_LIVE_OPS = new Set(["getPrices", "getBalances", "getPriceHistory", "getOrderPreview"]);

if (process.env.KEUMBANG_MCP_ALLOW_LIVE === "true") {
  server.tool(
    "call_api",
    "골드팝콘 Open API를 실제로 호출한다(조회 전용 · production 고정). getPrices/getBalances/getPriceHistory/getOrderPreview 만 허용 — 자금 이동 엔드포인트는 불가. secret_key 로 로컬 서명 후 요청한다.",
    {
      operationId: z.enum(["getPrices", "getBalances", "getPriceHistory", "getOrderPreview"]),
      accessKey: z.string().describe("gpk_... 액세스 키"),
      secretKey: z.string().describe("sk_... 시크릿 키. 로컬 서명에만 사용"),
      query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe("쿼리 파라미터. 예 getPriceHistory: {asset:'gold', bucket:'1h'}"),
      pathParams: z.record(z.string()).optional(),
    },
    async ({ operationId, accessKey, secretKey, query, pathParams }) => {
      const op = getOperation(operationId);
      if (!op) return errText(`operationId '${operationId}' 없음.`);
      // 게이트 재확인(방어적 이중화)
      if (!READONLY_LIVE_OPS.has(operationId)) return errText(`'${operationId}' 는 라이브 호출 화이트리스트에 없다(조회 전용).`);
      if (op.method !== "GET") return errText(`라이브 호출은 GET 만 허용. '${operationId}' 는 ${op.method}.`);

      const { url: subPath, error: pathErr } = substitutePath(op.path, pathParams);
      if (pathErr) return errText(pathErr);
      const { url: base, error: srvErr } = resolveServerUrl("production"); // 고정 — 인자로 못 바꾼다
      if (srvErr || !base) return errText(srvErr ?? "서버 url 해석 실패");
      const res = signRequest({ accessKey, secretKey, method: "GET", query: query as any });

      const qs = query && Object.keys(query).length > 0 ? "?" + new URLSearchParams(query as Record<string, string>).toString() : "";
      const target = base + subPath + qs;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const resp = await fetch(target, {
          method: "GET",
          headers: { Authorization: res.authorization },
          signal: controller.signal,
        });
        const bodyText = await resp.text();
        const rl = ["limit", "remaining", "reset"].map((k) => `${k}=${resp.headers.get("x-ratelimit-" + k) ?? "-"}`).join(" ");
        return text(
          `# ${operationId} @ production\n${op.method} ${target}\nHTTP ${resp.status}   rate[${rl}]\n\n\`\`\`json\n${bodyText}\n\`\`\``,
        );
      } catch (e: any) {
        return errText(`요청 실패: ${e?.name === "AbortError" ? "타임아웃(10s)" : e?.message ?? e}`);
      } finally {
        clearTimeout(timer);
      }
    },
  );
  process.stderr.write("call_api 활성 (조회 전용, production)\n");
}

// ── 리소스: 전체 스펙 ────────────────────────────────────────────────────────
server.resource("openapi-spec", "keumbang://openapi.yaml", async (uri) => ({
  contents: [
    {
      uri: uri.href,
      mimeType: "application/yaml",
      text: readFileSync(specPath(), "utf8"),
    },
  ],
}));

// info.description 산문(서명·한도·에러 전반)도 리소스로.
server.resource("overview", "keumbang://overview", async (uri) => ({
  contents: [{ uri: uri.href, mimeType: "text/markdown", text: getInfoDescription() }],
}));

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio 모드 — stdout 은 프로토콜 전용. 로그는 stderr.
  process.stderr.write("keumbang-openapi-mcp 시작 (stdio)\n");
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e?.stack ?? e}\n`);
  process.exit(1);
});
