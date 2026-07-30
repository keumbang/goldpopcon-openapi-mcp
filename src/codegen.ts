// 요청 하나에 대한 완결형 서명 코드 생성 — python / javascript / go / curl.
//
// 원칙: 본문은 "서명한 바이트를 그대로 전송"한다. 그래서 모든 템플릿은 JSON 을
// 문자열 리터럴 하나로 고정하고, 그 문자열을 해시하고 그 문자열을 전송한다.
// 객체를 재직렬화하지 않으므로 공백/순서 차이로 인한 query_hash 불일치가 원천 차단된다.
import type { HttpMethod } from "./signing.js";
import { canonicalQueryString } from "./signing.js";

export type Language = "python" | "javascript" | "go" | "curl";

export interface CodegenInput {
  operationId: string;
  method: HttpMethod;
  /** 서버 url + path. 예: https://api.goldpopcon.com/api/open/v1/sell/gold */
  fullUrl: string;
  body?: unknown;
  query?: Record<string, string | number | boolean>;
  needsIdempotency: boolean;
  ttlSeconds?: number;
}

const isBodyMethod = (m: HttpMethod) => m === "POST" || m === "PUT" || m === "PATCH";

/** 단일 인용부호 문자열에 안전하게 담기도록 최소 이스케이프. */
const sq = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

function pyQueryDict(query: Record<string, string | number | boolean>): string {
  const items = Object.keys(query).map((k) => `"${k}": ${JSON.stringify(String(query[k]))}`);
  return `{${items.join(", ")}}`;
}

export function generateCode(lang: Language, input: CodegenInput): string {
  const ttl = input.ttlSeconds ?? 30;
  const bodyMode = isBodyMethod(input.method);
  const rawBody = bodyMode ? JSON.stringify(input.body ?? {}) : "";
  const hasQuery = !bodyMode && !!input.query && Object.keys(input.query).length > 0;
  const canonical = hasQuery ? canonicalQueryString(input.query!) : "";

  switch (lang) {
    case "python":
      return python(input, { ttl, bodyMode, rawBody, hasQuery });
    case "javascript":
      return javascript(input, { ttl, bodyMode, rawBody, hasQuery });
    case "go":
      return go(input, { ttl, bodyMode, rawBody, hasQuery });
    case "curl":
      return curl(input, { ttl, bodyMode, rawBody, hasQuery, canonical });
    default:
      throw new Error(`지원하지 않는 언어: ${lang}`);
  }
}

interface Ctx {
  ttl: number;
  bodyMode: boolean;
  rawBody: string;
  hasQuery: boolean;
  canonical?: string;
}

// ── Python (PyJWT + requests) ───────────────────────────────────────────────
function python(i: CodegenInput, c: Ctx): string {
  const L: string[] = [];
  L.push(`# ${i.operationId} — pip install pyjwt requests`);
  L.push(`import jwt, uuid, hashlib, time, requests`);
  L.push(``);
  L.push(`ACCESS_KEY = "gpk_live_여기에"`);
  L.push(`SECRET_KEY = "sk_여기에"  # HMAC 키로 문자열 그대로 사용(sk_ 포함, base64 디코딩 금지)`);
  L.push(`URL = "${i.fullUrl}"`);
  L.push(``);
  L.push(`now = int(time.time())`);
  L.push(`payload = {`);
  L.push(`    "access_key": ACCESS_KEY,`);
  L.push(`    "nonce": str(uuid.uuid4()),  # 요청마다 새 값`);
  L.push(`    "iat": now,`);
  L.push(`    "exp": now + ${c.ttl},  # 수명 ≤ 60s`);
  L.push(`}`);

  if (c.bodyMode) {
    L.push(``);
    L.push(`# POST/PUT/PATCH: query_hash = SHA512(요청 본문 raw 바이트)`);
    L.push(`body = '${sq(c.rawBody)}'  # 이 문자열을 그대로 전송한다 — 재직렬화 금지`);
    L.push(`payload["query_hash"] = hashlib.sha512(body.encode()).hexdigest()`);
    L.push(`payload["query_hash_alg"] = "SHA512"`);
    L.push(``);
    L.push(`token = jwt.encode(payload, SECRET_KEY, algorithm="HS256")`);
    L.push(`resp = requests.${i.method.toLowerCase()}(URL, data=body, headers={`);
    L.push(`        "Authorization": f"Bearer {token}",`);
    L.push(`        "Content-Type": "application/json",`);
    if (i.needsIdempotency) L.push(`        "Idempotency-Key": str(uuid.uuid4()),  # 재시도 시 같은 키 재사용`);
    L.push(`})`);
  } else if (c.hasQuery) {
    L.push(``);
    L.push(`# GET/DELETE: query_hash = SHA512(정규화 querystring)`);
    L.push(`params = ${pyQueryDict(i.query!)}`);
    L.push(``);
    L.push(`def canonical_qs(p):`);
    L.push(`    pairs = []`);
    L.push(`    for k, v in p.items():`);
    L.push(`        for one in (v if isinstance(v, list) else [v]):`);
    L.push(`            pairs.append((k, str(one)))`);
    L.push(`    pairs.sort()  # 키 asc, 같은 키 값 asc`);
    L.push(`    return "&".join(f"{k}={v}" for k, v in pairs)  # 퍼센트 디코딩 값`);
    L.push(``);
    L.push(`payload["query_hash"] = hashlib.sha512(canonical_qs(params).encode()).hexdigest()`);
    L.push(`payload["query_hash_alg"] = "SHA512"`);
    L.push(``);
    L.push(`token = jwt.encode(payload, SECRET_KEY, algorithm="HS256")`);
    L.push(`resp = requests.${i.method.toLowerCase()}(URL, params=params, headers={`);
    L.push(`        "Authorization": f"Bearer {token}",`);
    L.push(`})`);
  } else {
    L.push(`# 본문·쿼리 없음 → query_hash 생략`);
    L.push(``);
    L.push(`token = jwt.encode(payload, SECRET_KEY, algorithm="HS256")`);
    L.push(`resp = requests.${i.method.toLowerCase()}(URL, headers={`);
    L.push(`        "Authorization": f"Bearer {token}",`);
    L.push(`})`);
  }
  L.push(``);
  L.push(``);
  L.push(`print(resp.status_code, resp.text)`);
  return L.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

// ── JavaScript (Node 내장 crypto + fetch) ───────────────────────────────────
function javascript(i: CodegenInput, c: Ctx): string {
  const idem = i.needsIdempotency ? `    "Idempotency-Key": randomUUID(), // 재시도 시 같은 키 재사용\n` : "";
  const L: string[] = [];
  L.push(`// ${i.operationId} — Node 18+ (외부 의존성 없음)`);
  L.push(`import { createHmac, createHash, randomUUID } from "node:crypto";`);
  L.push(``);
  L.push(`const ACCESS_KEY = "gpk_live_여기에";`);
  L.push(`const SECRET_KEY = "sk_여기에"; // HMAC 키로 문자열 그대로 사용`);
  L.push(`const URL = "${i.fullUrl}";`);
  L.push(``);
  L.push(`const b64url = (b) => b.toString("base64").replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");`);
  L.push(`const now = Math.floor(Date.now() / 1000);`);
  L.push(`const payload = { access_key: ACCESS_KEY, nonce: randomUUID(), iat: now, exp: now + ${c.ttl} };`);

  let requestLine: string;
  if (c.bodyMode) {
    L.push(``);
    L.push(`// POST/PUT/PATCH: query_hash = SHA512(본문 raw 바이트)`);
    L.push(`const body = '${sq(c.rawBody)}'; // 이 문자열을 그대로 전송 — 재직렬화 금지`);
    L.push(`payload.query_hash = createHash("sha512").update(body).digest("hex");`);
    L.push(`payload.query_hash_alg = "SHA512";`);
    requestLine =
      `const res = await fetch(URL, { method: "${i.method}", body, headers: {\n` +
      `    Authorization: \`Bearer \${token}\`,\n` +
      `    "Content-Type": "application/json",\n` +
      idem +
      `} });`;
  } else if (c.hasQuery) {
    L.push(``);
    L.push(`// GET/DELETE: query_hash = SHA512(정규화 querystring)`);
    L.push(`const params = ${JSON.stringify(i.query)};`);
    L.push(`const canonical = Object.entries(params)`);
    L.push(`    .flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => [k, String(x)]))`);
    L.push(`    .sort((a, b) => (a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)) // 키 asc → 값 asc`);
    L.push(`    .map(([k, v]) => \`\${k}=\${v}\`).join("&");`);
    L.push(`payload.query_hash = createHash("sha512").update(canonical).digest("hex");`);
    L.push(`payload.query_hash_alg = "SHA512";`);
    requestLine =
      `const qs = new URLSearchParams(params).toString();\n` +
      `const res = await fetch(\`\${URL}?\${qs}\`, { method: "${i.method}", headers: {\n` +
      `    Authorization: \`Bearer \${token}\`,\n` +
      `} });`;
  } else {
    L.push(`// 본문·쿼리 없음 → query_hash 생략`);
    requestLine =
      `const res = await fetch(URL, { method: "${i.method}", headers: {\n` +
      `    Authorization: \`Bearer \${token}\`,\n` +
      `} });`;
  }

  L.push(``);
  L.push(`const header = { alg: "HS256", typ: "JWT" };`);
  L.push(
    `const signingInput = b64url(Buffer.from(JSON.stringify(header))) + "." + b64url(Buffer.from(JSON.stringify(payload)));`,
  );
  L.push(`const sig = b64url(createHmac("sha256", SECRET_KEY).update(signingInput).digest());`);
  L.push(`const token = signingInput + "." + sig;`);
  L.push(``);
  L.push(requestLine);
  L.push(`console.log(res.status, await res.text());`);
  return L.join("\n") + "\n";
}

// ── Go (표준 라이브러리만) ───────────────────────────────────────────────────
function go(i: CodegenInput, c: Ctx): string {
  const L: string[] = [];
  L.push(`// ${i.operationId} — 표준 라이브러리만 사용`);
  L.push(`package main`);
  L.push(``);
  L.push(`import (`);
  L.push(`\t"crypto/hmac"`);
  L.push(`\t"crypto/rand"`);
  L.push(`\t"crypto/sha256"`);
  L.push(`\t"crypto/sha512"`);
  L.push(`\t"encoding/base64"`);
  L.push(`\t"encoding/hex"`);
  L.push(`\t"encoding/json"`);
  L.push(`\t"fmt"`);
  L.push(`\t"io"`);
  L.push(`\t"net/http"`);
  if (c.bodyMode) L.push(`\t"strings"`);
  L.push(`\t"time"`);
  L.push(`)`);
  L.push(``);
  L.push(`const (`);
  L.push(`\taccessKey = "gpk_live_여기에"`);
  L.push(`\tsecretKey = "sk_여기에" // HMAC 키로 문자열 그대로 사용`);
  L.push(`\turl       = "${i.fullUrl}"`);
  L.push(`)`);
  L.push(``);
  L.push(`func b64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }`);
  L.push(``);
  L.push(`func uuidV4() string {`);
  L.push(`\tb := make([]byte, 16)`);
  L.push(`\trand.Read(b)`);
  L.push(`\tb[6] = (b[6] & 0x0f) | 0x40`);
  L.push(`\tb[8] = (b[8] & 0x3f) | 0x80`);
  L.push(`\treturn fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])`);
  L.push(`}`);
  L.push(``);
  L.push(`func main() {`);
  L.push(`\tnow := time.Now().Unix()`);
  L.push(`\tpayload := map[string]any{`);
  L.push(`\t\t"access_key": accessKey,`);
  L.push(`\t\t"nonce":      uuidV4(),`);
  L.push(`\t\t"iat":        now,`);
  L.push(`\t\t"exp":        now + ${c.ttl},`);
  L.push(`\t}`);

  if (c.bodyMode) {
    L.push(``);
    L.push(`\t// POST/PUT/PATCH: query_hash = SHA512(본문 raw 바이트)`);
    L.push(`\tbody := \`${c.rawBody}\` // 이 문자열을 그대로 전송`);
    L.push(`\tsum := sha512.Sum512([]byte(body))`);
    L.push(`\tpayload["query_hash"] = hex.EncodeToString(sum[:])`);
    L.push(`\tpayload["query_hash_alg"] = "SHA512"`);
  } else if (c.hasQuery) {
    L.push(``);
    L.push(`\t// GET: query_hash = SHA512(정규화 querystring "${c.canonical ?? canonicalQueryString(i.query!)}")`);
    L.push(`\tcanonical := "${canonicalQueryString(i.query!)}"`);
    L.push(`\tsum := sha512.Sum512([]byte(canonical))`);
    L.push(`\tpayload["query_hash"] = hex.EncodeToString(sum[:])`);
    L.push(`\tpayload["query_hash_alg"] = "SHA512"`);
  } else {
    L.push(`\t// 본문·쿼리 없음 → query_hash 생략`);
  }

  L.push(``);
  L.push(`\theaderJSON, _ := json.Marshal(map[string]string{"alg": "HS256", "typ": "JWT"})`);
  L.push(`\tpayloadJSON, _ := json.Marshal(payload)`);
  L.push(`\tsigningInput := b64url(headerJSON) + "." + b64url(payloadJSON)`);
  L.push(`\tmac := hmac.New(sha256.New, []byte(secretKey))`);
  L.push(`\tmac.Write([]byte(signingInput))`);
  L.push(`\ttoken := signingInput + "." + b64url(mac.Sum(nil))`);
  L.push(``);
  if (c.bodyMode) {
    L.push(`\treq, _ := http.NewRequest("${i.method}", url, strings.NewReader(body))`);
    L.push(`\treq.Header.Set("Content-Type", "application/json")`);
    if (i.needsIdempotency) L.push(`\treq.Header.Set("Idempotency-Key", uuidV4()) // 재시도 시 같은 키 재사용`);
  } else if (c.hasQuery) {
    L.push(`\treq, _ := http.NewRequest("${i.method}", url+"?"+canonical, nil)`);
  } else {
    L.push(`\treq, _ := http.NewRequest("${i.method}", url, nil)`);
  }
  L.push(`\treq.Header.Set("Authorization", "Bearer "+token)`);
  L.push(``);
  L.push(`\tresp, err := http.DefaultClient.Do(req)`);
  L.push(`\tif err != nil { panic(err) }`);
  L.push(`\tdefer resp.Body.Close()`);
  L.push(`\tout, _ := io.ReadAll(resp.Body)`);
  L.push(`\tfmt.Println(resp.StatusCode, string(out))`);
  L.push(`}`);
  return L.join("\n") + "\n";
}

// ── curl (bash + openssl) ───────────────────────────────────────────────────
function curl(i: CodegenInput, c: Ctx): string {
  const L: string[] = [];
  L.push(`#!/usr/bin/env bash`);
  L.push(`# ${i.operationId} — openssl + uuidgen 필요`);
  L.push(`set -euo pipefail`);
  L.push(``);
  L.push(`ACCESS_KEY="gpk_live_여기에"`);
  L.push(`SECRET_KEY="sk_여기에"   # HMAC 키로 문자열 그대로 사용`);
  L.push(`URL="${i.fullUrl}"`);
  L.push(``);
  L.push(`b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }`);
  L.push(`NOW=$(date +%s)`);
  L.push(`NONCE=$(uuidgen | tr 'A-Z' 'a-z')`);

  let hashLines: string[] = [];
  let payloadExtra = "";
  let requestTail: string[] = [];

  if (c.bodyMode) {
    L.push(`BODY='${sq(c.rawBody)}'   # 이 문자열을 그대로 전송`);
    hashLines.push(`QHASH=$(printf '%s' "$BODY" | openssl dgst -sha512 -hex | awk '{print $NF}')`);
    payloadExtra = `,\\"query_hash\\":\\"$QHASH\\",\\"query_hash_alg\\":\\"SHA512\\"`;
    if (i.needsIdempotency) {
      L.push(`IDEM=$(uuidgen | tr 'A-Z' 'a-z')   # 재시도 시 같은 키 재사용`);
      requestTail = [
        `curl -sS -X ${i.method} "$URL" \\`,
        `  -H "Authorization: Bearer $JWT" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -H "Idempotency-Key: $IDEM" \\`,
        `  --data-raw "$BODY"`,
      ];
    } else {
      requestTail = [
        `curl -sS -X ${i.method} "$URL" \\`,
        `  -H "Authorization: Bearer $JWT" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  --data-raw "$BODY"`,
      ];
    }
  } else if (c.hasQuery) {
    L.push(`CANONICAL="${c.canonical}"   # 정규화 querystring`);
    hashLines.push(`QHASH=$(printf '%s' "$CANONICAL" | openssl dgst -sha512 -hex | awk '{print $NF}')`);
    payloadExtra = `,\\"query_hash\\":\\"$QHASH\\",\\"query_hash_alg\\":\\"SHA512\\"`;
    requestTail = [`curl -sS -X ${i.method} "$URL?$CANONICAL" \\`, `  -H "Authorization: Bearer $JWT"`];
  } else {
    requestTail = [`curl -sS -X ${i.method} "$URL" \\`, `  -H "Authorization: Bearer $JWT"`];
  }

  L.push(...hashLines);
  L.push(``);
  L.push(`HEADER=$(printf '%s' '{"alg":"HS256","typ":"JWT"}' | b64url)`);
  L.push(
    `PAYLOAD=$(printf '%s' "{\\"access_key\\":\\"$ACCESS_KEY\\",\\"nonce\\":\\"$NONCE\\",\\"iat\\":$NOW,\\"exp\\":$((NOW+${c.ttl}))${payloadExtra}}" | b64url)`,
  );
  L.push(`SIGNING="$HEADER.$PAYLOAD"`);
  L.push(`SIG=$(printf '%s' "$SIGNING" | openssl dgst -sha256 -hmac "$SECRET_KEY" -binary | b64url)`);
  L.push(`JWT="$SIGNING.$SIG"`);
  L.push(``);
  L.push(...requestTail);
  return L.join("\n") + "\n";
}
