// 금방 Open API 요청 서명 — 서버 검증 규칙과 1:1 대응.
//
// 규칙 출처: docs/openapi.yaml §2 인증.
//   - JWT HS256, HMAC 키 = secret_key 문자열 바이트 그대로(sk_ 접두사 포함, base64 디코딩 안 함)
//   - payload: access_key, nonce(uuid v4), iat, exp, [query_hash, query_hash_alg]
//   - POST/PUT/PATCH  → query_hash = SHA512(요청 본문 raw 바이트)
//   - GET/DELETE      → query_hash = SHA512(정규화 querystring)
//   - 본문도 쿼리도 없으면 query_hash / query_hash_alg 를 생략한다
//   - exp - iat ≤ 60초, iat 는 현재보다 30초 넘게 미래이면 안 됨, nonce 180초 1회용
import { createHmac, createHash, randomUUID } from "node:crypto";

const b64url = (buf: Buffer): string =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const b64urlJson = (obj: unknown): string =>
  b64url(Buffer.from(JSON.stringify(obj), "utf8"));

/** SHA512 소문자 hex. */
export const sha512Hex = (input: string | Buffer): string =>
  createHash("sha512").update(input).digest("hex");

/**
 * 정규화 querystring — GET/DELETE query_hash 입력.
 *   1. 키 오름차순
 *   2. 같은 키에 값 여럿이면 값도 오름차순
 *   3. k=v 를 & 로 연결
 *   4. 퍼센트 디코딩된 값 사용(서버가 URL.Query() 로 디코딩 후 비교)
 * 서버 규칙: docs/openapi.yaml §2 "정규화 querystring 규칙".
 */
export function canonicalQueryString(
  query: Record<string, string | number | boolean | Array<string | number | boolean>>,
): string {
  const pairs: Array<[string, string]> = [];
  for (const key of Object.keys(query)) {
    const raw = query[key];
    const values = Array.isArray(raw) ? raw : [raw];
    for (const v of values) pairs.push([key, String(v)]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const bodyMethods = new Set<HttpMethod>(["POST", "PUT", "PATCH"]);

export interface SignInput {
  accessKey: string;
  secretKey: string;
  method: HttpMethod;
  /** POST/PUT/PATCH 전송 본문 raw 문자열. 서명한 바이트를 그대로 전송해야 한다. */
  rawBody?: string;
  /** GET/DELETE 쿼리 파라미터. */
  query?: Record<string, string | number | boolean | Array<string | number | boolean>>;
  /** JWT 수명(초). 기본 30, 최대 60. */
  ttlSeconds?: number;
  /** 테스트/재현용 iat 고정(unix seconds). 미지정 시 now. */
  iat?: number;
  /** 테스트/재현용 nonce 고정. 미지정 시 uuid v4. */
  nonce?: string;
  /** now(unix seconds) 주입 — 결정론 테스트용. 미지정 시 실제 시각. */
  now?: number;
}

export interface SignResult {
  jwt: string;
  authorization: string;
  nonce: string;
  iat: number;
  exp: number;
  queryHash: string | null;
  /** query_hash 계산에 실제로 들어간 입력(본문 raw 또는 정규화 querystring). null = 생략. */
  hashInput: string | null;
  payload: Record<string, unknown>;
}

/** 요청 하나에 대한 서명 JWT를 계산한다. secret_key 는 로컬에서만 쓰이고 전송되지 않는다. */
export function signRequest(input: SignInput): SignResult {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const ttl = Math.min(Math.max(input.ttlSeconds ?? 30, 1), 60);
  const iat = input.iat ?? now;
  const exp = iat + ttl;
  const nonce = input.nonce ?? randomUUID();

  let queryHash: string | null = null;
  let hashInput: string | null = null;
  if (bodyMethods.has(input.method)) {
    if (input.rawBody !== undefined && input.rawBody !== "") {
      hashInput = input.rawBody;
      queryHash = sha512Hex(Buffer.from(input.rawBody, "utf8"));
    }
  } else {
    if (input.query && Object.keys(input.query).length > 0) {
      hashInput = canonicalQueryString(input.query);
      queryHash = sha512Hex(hashInput);
    }
  }

  const payload: Record<string, unknown> = {
    access_key: input.accessKey,
    nonce,
    iat,
    exp,
  };
  if (queryHash !== null) {
    payload.query_hash = queryHash;
    payload.query_hash_alg = "SHA512";
  }

  const header = { alg: "HS256", typ: "JWT" };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = b64url(createHmac("sha256", input.secretKey).update(signingInput).digest());
  const jwt = `${signingInput}.${sig}`;

  return {
    jwt,
    authorization: `Bearer ${jwt}`,
    nonce,
    iat,
    exp,
    queryHash,
    hashInput,
    payload,
  };
}

export interface VerifyInput {
  secretKey: string;
  token: string;
  method: HttpMethod;
  /** 실제 전송한(할) 본문 raw. query_hash 대조에 필요. */
  rawBody?: string;
  /** 실제 전송한(할) 쿼리. query_hash 대조에 필요. */
  query?: Record<string, string | number | boolean | Array<string | number | boolean>>;
  now?: number;
}

export interface VerifyResult {
  valid: boolean;
  /** 서버 기준으로 이 토큰이 왜 401 이 나는지(또는 통과하는지) 진단 목록. */
  checks: Array<{ name: string; pass: boolean; detail: string }>;
  decodedHeader: unknown;
  decodedPayload: unknown;
}

/** 토큰을 서버와 같은 순서로 검증해 401 원인을 로컬 진단한다. */
export function verifySignature(input: VerifyInput): VerifyResult {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const checks: VerifyResult["checks"] = [];
  const parts = input.token.replace(/^Bearer\s+/i, "").split(".");

  if (parts.length !== 3) {
    return {
      valid: false,
      checks: [{ name: "format", pass: false, detail: `JWT 는 3개 세그먼트여야 한다(현재 ${parts.length})` }],
      decodedHeader: null,
      decodedPayload: null,
    };
  }

  const [h, p, s] = parts;
  let header: any = null;
  let payload: any = null;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return {
      valid: false,
      checks: [{ name: "decode", pass: false, detail: "header/payload base64url JSON 디코딩 실패" }],
      decodedHeader: header,
      decodedPayload: payload,
    };
  }

  // 1. alg
  const algOk = header?.alg === "HS256";
  checks.push({ name: "alg", pass: algOk, detail: `alg=${header?.alg} (기대 HS256)` });

  // 2. 서명
  const expectedSig = b64url(createHmac("sha256", input.secretKey).update(`${h}.${p}`).digest());
  const sigOk = expectedSig === s;
  checks.push({
    name: "signature",
    pass: sigOk,
    detail: sigOk ? "HMAC-SHA256 일치" : "서명 불일치 — secret_key 또는 서명 대상 문자열 확인",
  });

  // 3. 시각 클레임
  const hasIat = typeof payload?.iat === "number";
  const hasExp = typeof payload?.exp === "number";
  checks.push({ name: "iat/exp 존재", pass: hasIat && hasExp, detail: `iat=${payload?.iat} exp=${payload?.exp}` });
  if (hasExp) checks.push({ name: "exp 미만료", pass: payload.exp > now, detail: `exp(${payload.exp}) > now(${now})` });
  if (hasIat && hasExp)
    checks.push({ name: "수명 ≤60s", pass: payload.exp - payload.iat <= 60, detail: `exp-iat=${payload.exp - payload.iat}` });
  if (hasIat) checks.push({ name: "iat skew ≤30s", pass: payload.iat - now <= 30, detail: `iat-now=${payload.iat - now}` });

  // 4. query_hash 대조
  let expectedHash: string | null = null;
  if (bodyMethods.has(input.method)) {
    if (input.rawBody !== undefined && input.rawBody !== "") expectedHash = sha512Hex(Buffer.from(input.rawBody, "utf8"));
  } else if (input.query && Object.keys(input.query).length > 0) {
    expectedHash = sha512Hex(canonicalQueryString(input.query));
  }
  if (expectedHash === null) {
    checks.push({
      name: "query_hash 생략",
      pass: payload.query_hash === undefined,
      detail: payload.query_hash === undefined ? "본문·쿼리 없음 → 생략 정상" : "본문·쿼리 없는데 query_hash 존재",
    });
  } else {
    checks.push({
      name: "query_hash 일치",
      pass: payload.query_hash === expectedHash,
      detail: payload.query_hash === expectedHash
        ? "일치"
        : `불일치\n  기대: ${expectedHash}\n  실제: ${payload.query_hash}\n  → 서명한 바이트와 전송 바이트가 다르다(직렬화 공백/순서)`,
    });
  }

  const valid = checks.every((c) => c.pass);
  return { valid, checks, decodedHeader: header, decodedPayload: payload };
}
