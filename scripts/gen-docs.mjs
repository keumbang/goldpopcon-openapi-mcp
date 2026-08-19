// spec/openapi.yaml → docs/ (GitHub Pages 사이트) 생성.
//
// 문서 원문(빠른 시작·서명·한도·에러코드)은 스펙의 info.description 이 원본이고,
// 이 스크립트는 거기에 엔드포인트 표와 진입 헤더만 붙여 웹에서 읽히는 형태로 만든다.
// 내용을 고치려면 백엔드 스펙을 고치고 sync-spec 을 돌린다 — 이 파일을 직접 고치지 않는다.
//   npm run docs
import { writeFileSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadSpec, listOperations, getServers, getInfoDescription } from "../dist/spec.js";

const APP_STORE = "https://apps.apple.com/kr/app/id6747214612";
const PLAY_STORE = "https://play.google.com/store/apps/details?id=com.keumbang.goldpopcorn";
const REPO = "https://github.com/keumbang/goldpopcon-openapi-mcp";

const spec = loadSpec();
const base = getServers()[0]?.url ?? "";
const ops = listOperations().filter((o) => o.isOpenApi);

const rows = ops
  .map(
    (o) =>
      `| \`${o.method}\` | \`${o.path}\` | \`${o.operationId}\` | ${o.summary} | ${o.scope} | ${
        o.needsIdempotency ? "필수" : "—"
      } | ${o.rateBucket} |`,
  )
  .join("\n");

const md = `---
layout: default
title: 골드팝콘 Open API
---
<!-- 생성 파일이다. 직접 고치지 말 것 — 원본은 spec/openapi.yaml 의 info.description, 갱신은 \`npm run docs\`. -->
# 골드팝콘 Open API

${spec.info?.summary ?? ""}

| | |
|---|---|
| Base URL | \`${base}\` |
| 인증 | 요청마다 JWT 서명 — [§3 인증](#3-인증--요청마다-jwt-서명) |
| 키 발급 | 골드팝콘 앱 · [App Store](${APP_STORE}) · [Google Play](${PLAY_STORE}) |
| 스키마 브라우저 | [Redoc](./redoc.html) — 요청·응답 스키마 상세 |
| 스펙 원문 | [openapi.yaml](./openapi.yaml) (OpenAPI ${spec.openapi}) |
| 연동 코드 생성 | [MCP 서버](${REPO}#readme) — AI 코딩 어시스턴트가 서명 코드를 만들어 준다 |

## 엔드포인트

| 메서드 | 경로 | operationId | 설명 | 권한 | 멱등키 | rate |
|---|---|---|---|---|---|---|
${rows}

경로는 Base URL 뒤에 붙는다 — \`${base}${ops[0]?.path ?? ""}\`.

---

${getInfoDescription()}
`;

const docs = resolve(dirname(fileURLToPath(import.meta.url)), "../docs");
writeFileSync(resolve(docs, "index.md"), md);
// Redoc 이 같은 오리진에서 읽을 스펙 사본. Pages 는 docs/ 만 서빙하므로 여기에도 둔다.
copyFileSync(resolve(docs, "../spec/openapi.yaml"), resolve(docs, "openapi.yaml"));
console.log(`generated: ${docs}/index.md + openapi.yaml (${ops.length} endpoints, ${md.length} bytes)`);
