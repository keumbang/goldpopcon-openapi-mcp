// 서명 회귀 테스트 — 서버 검증 규칙과의 드리프트 방어.
// 서버 Go 코드를 공유하지 않으므로, 규칙이 어긋나면 여기서 잡는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { signRequest, verifySignature, canonicalQueryString, sha512Hex } from "./signing.js";

test("POST 왕복 — 서명 후 검증 통과", () => {
  const s = signRequest({ accessKey: "gpk", secretKey: "sk", method: "POST", rawBody: '{"quantity":1}', now: 1000, nonce: "n" });
  assert.equal(s.jwt.split(".").length, 3);
  assert.equal(s.payload.query_hash_alg, "SHA512");
  const v = verifySignature({ token: s.jwt, secretKey: "sk", method: "POST", rawBody: '{"quantity":1}', now: 1010 });
  assert.ok(v.valid);
});

test("본문 변조 → query_hash 불일치", () => {
  const s = signRequest({ accessKey: "gpk", secretKey: "sk", method: "POST", rawBody: '{"quantity":1}', now: 1000 });
  const v = verifySignature({ token: s.jwt, secretKey: "sk", method: "POST", rawBody: '{"quantity":2}', now: 1010 });
  assert.ok(!v.valid);
  assert.ok(v.checks.find((c) => c.name === "query_hash 일치" && !c.pass));
});

test("secret 불일치 → 서명 실패", () => {
  const s = signRequest({ accessKey: "gpk", secretKey: "sk", method: "POST", rawBody: "{}", now: 1000 });
  const v = verifySignature({ token: s.jwt, secretKey: "other", method: "POST", rawBody: "{}", now: 1010 });
  assert.ok(!v.valid);
  assert.ok(v.checks.find((c) => c.name === "signature" && !c.pass));
});

test("exp 만료 → 검증 실패", () => {
  const s = signRequest({ accessKey: "gpk", secretKey: "sk", method: "GET", now: 1000, ttlSeconds: 30 });
  const v = verifySignature({ token: s.jwt, secretKey: "sk", method: "GET", now: 1100 });
  assert.ok(v.checks.find((c) => c.name === "exp 미만료" && !c.pass));
});

test("수명 60초 초과 불가 — 클램프", () => {
  const s = signRequest({ accessKey: "gpk", secretKey: "sk", method: "GET", now: 1000, ttlSeconds: 999 });
  assert.equal((s.payload.exp as number) - (s.payload.iat as number), 60);
});

test("본문·쿼리 없으면 query_hash 생략", () => {
  const s = signRequest({ accessKey: "gpk", secretKey: "sk", method: "GET", now: 1000 });
  assert.equal(s.queryHash, null);
  assert.equal(s.payload.query_hash, undefined);
  const v = verifySignature({ token: s.jwt, secretKey: "sk", method: "GET", now: 1010 });
  assert.ok(v.checks.find((c) => c.name === "query_hash 생략" && c.pass));
});

test("정규화 querystring — 키 asc, 다중값 asc, 퍼센트 디코딩", () => {
  assert.equal(canonicalQueryString({ b: "2", a: ["z", "a"] }), "a=a&a=z&b=2");
  assert.equal(canonicalQueryString({ from: "2026-07-21T00:00:00Z" }), "from=2026-07-21T00:00:00Z");
});

test("GET query_hash = SHA512(정규화 querystring)", () => {
  const q = { asset: "gold", bucket: "1h" };
  const s = signRequest({ accessKey: "gpk", secretKey: "sk", method: "GET", query: q, now: 1000 });
  assert.equal(s.queryHash, sha512Hex("asset=gold&bucket=1h"));
});
