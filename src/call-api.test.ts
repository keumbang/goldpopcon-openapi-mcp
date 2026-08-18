// call_api 구조화 출력 회귀 테스트.
// SDK 는 outputSchema 와 structuredContent 가 어긋나면 tools/call 을 통째로 에러로
// 돌려보낸다 — 헤더 하나가 숫자 아닌 값으로 오는 정도로도 자동화 루프가 죽는다.
// 실제 서버 대신 로컬 스텁을 띄우고, 스펙의 서버 url 만 바꿔치기해 전 경로를 태운다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const here = resolve(fileURLToPath(import.meta.url), "..");

/** 스텁 서버를 띄우고 base url 을 돌려준다. handler 로 응답을 갈아끼운다. */
async function stub(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const srv = createServer(handler);
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const { port } = srv.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/api`, close: () => srv.close() };
}

/** 스텁을 가리키는 임시 스펙 사본 경로. */
function specPointingAt(baseUrl: string) {
  // replaceAll — 같은 url 이 info.description 산문에도 있어서 첫 개만 바꾸면
  // servers 블록이 남고 테스트가 실제 production 을 때린다.
  const yaml = readFileSync(join(here, "../spec/openapi.yaml"), "utf8").replaceAll("https://api.goldpopcon.com/api", baseUrl);
  const path = join(mkdtempSync(join(tmpdir(), "kb-spec-")), "openapi.yaml");
  writeFileSync(path, yaml);
  return path;
}

/** 서버를 stdio 로 띄워 call_api 한 번 호출하고 결과를 돌려준다. */
async function callApi(specFile: string, args: Record<string, unknown>): Promise<any> {
  const child = spawn(process.execPath, [join(here, "index.js")], {
    env: {
      ...process.env,
      GOLDPOPCON_OPENAPI_SPEC: specFile,
      GOLDPOPCON_MCP_ALLOW_LIVE: "true",
      GOLDPOPCON_ACCESS_KEY: "gpk_test",
      GOLDPOPCON_SECRET_KEY: "sk_test",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const send = (msg: unknown) => child.stdin.write(JSON.stringify(msg) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "call_api", arguments: args } });

  let buf = "";
  try {
    for await (const chunk of child.stdout) {
      buf += chunk;
      for (const line of buf.split("\n").slice(0, -1)) {
        const msg = JSON.parse(line);
        if (msg.id === 2) return msg;
      }
      buf = buf.slice(buf.lastIndexOf("\n") + 1);
    }
  } finally {
    child.kill();
  }
  throw new Error("응답 없음");
}

test("call_api — 200 응답이 structuredContent 로 온다", async () => {
  const s = await stub((req, res) => {
    res.writeHead(200, {
      "content-type": "application/json",
      "x-ratelimit-limit": "600",
      "x-ratelimit-remaining": "599",
      "x-ratelimit-reset": "1730000000",
    });
    res.end(JSON.stringify({ gold: { price_krw: 100 } }));
  });
  try {
    const msg = await callApi(specPointingAt(s.url), { operationId: "getPrices" });
    assert.equal(msg.error, undefined, `tools/call 에러: ${JSON.stringify(msg.error)}`);
    const sc = msg.result.structuredContent;
    assert.match(sc.url, /^http:\/\/127\.0\.0\.1:/, "스텁이 아닌 실제 서버로 나갔다");
    assert.equal(sc.status, 200);
    assert.equal(sc.ok, true);
    assert.deepEqual(sc.data, { gold: { price_krw: 100 } });
    assert.equal(sc.rateLimit.remaining, 599);
    assert.equal(sc.rateLimit.retryAfter, null);
  } finally {
    s.close();
  }
});

test("call_api — 429 는 retryAfter 를 채우고, 비 JSON 본문은 raw 로 간다", async () => {
  const s = await stub((req, res) => {
    res.writeHead(429, { "content-type": "text/html", "retry-after": "12" });
    res.end("<html>rate limited</html>");
  });
  try {
    const msg = await callApi(specPointingAt(s.url), { operationId: "getPrices" });
    assert.equal(msg.error, undefined, `tools/call 에러: ${JSON.stringify(msg.error)}`);
    const sc = msg.result.structuredContent;
    assert.equal(sc.status, 429);
    assert.equal(sc.ok, false);
    assert.equal(sc.rateLimit.retryAfter, 12);
    assert.equal(sc.rateLimit.limit, null); // 헤더 없음 → null (문자열 "-" 아님)
    assert.equal(sc.data, undefined);
    assert.match(sc.raw, /rate limited/);
  } finally {
    s.close();
  }
});
